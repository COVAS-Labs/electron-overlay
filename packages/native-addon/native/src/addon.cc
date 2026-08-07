#include <algorithm>
#include <cctype>
#include <cstdint>
#include <cstring>
#include <memory>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

#include <napi.h>

#if defined(__linux__)
#include <X11/Xatom.h>
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <X11/extensions/Xfixes.h>
#include <X11/extensions/shape.h>

namespace {

struct Rect {
  int x = 0;
  int y = 0;
  unsigned int width = 1;
  unsigned int height = 1;
};

struct WindowQuery {
  std::string title;
  std::string class_name;
  bool exact = false;
};

struct ParentInfo {
  Window window = None;
  std::string title;
  std::string class_name;
  Rect bounds;
};

struct Config {
  std::optional<Rect> bounds;
  std::optional<WindowQuery> parent_query;
  bool position_parent = false;
  bool click_through = true;
  bool always_on_top = true;
  bool preserve_compositing = true;
  bool all_workspaces = false;
};

Atom Intern(Display* display, const char* name) {
  return XInternAtom(display, name, False);
}

std::mutex x_error_mutex;
int trapped_x_error = 0;

int TrapXError(Display*, XErrorEvent* event) {
  trapped_x_error = event->error_code;
  return 0;
}

bool GetWindowAttributesSafely(Display* display, Window window, XWindowAttributes* attributes) {
  std::lock_guard<std::mutex> lock(x_error_mutex);
  XSync(display, False);
  trapped_x_error = 0;
  XErrorHandler previous = XSetErrorHandler(TrapXError);
  const int status = XGetWindowAttributes(display, window, attributes);
  XSync(display, False);
  XSetErrorHandler(previous);
  return status != 0 && trapped_x_error == 0;
}

std::string Lower(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char character) {
    return static_cast<char>(std::tolower(character));
  });
  return value;
}

bool Matches(const std::string& value, const std::string& expected, bool exact) {
  const std::string lowered_value = Lower(value);
  const std::string lowered_expected = Lower(expected);
  return exact ? lowered_value == lowered_expected : lowered_value.find(lowered_expected) != std::string::npos;
}

std::vector<unsigned char> ReadProperty(Display* display, Window window, Atom property, Atom requested_type = AnyPropertyType) {
  Atom actual_type = None;
  int actual_format = 0;
  unsigned long count = 0;
  unsigned long remaining = 0;
  unsigned char* data = nullptr;
  const int status = XGetWindowProperty(display, window, property, 0, 262144, False, requested_type,
                                        &actual_type, &actual_format, &count, &remaining, &data);
  if (status != Success || data == nullptr || actual_format == 0) {
    if (data != nullptr) XFree(data);
    return {};
  }
  // Xlib expands format-32 properties to native longs on 64-bit clients.
  const size_t bytes = count * (actual_format == 32 ? sizeof(unsigned long) : static_cast<size_t>(actual_format / 8));
  std::vector<unsigned char> result(data, data + bytes);
  XFree(data);
  return result;
}

std::string WindowTitle(Display* display, Window window) {
  const auto utf8 = ReadProperty(display, window, Intern(display, "_NET_WM_NAME"), Intern(display, "UTF8_STRING"));
  if (!utf8.empty()) return std::string(reinterpret_cast<const char*>(utf8.data()), utf8.size());
  char* title = nullptr;
  if (XFetchName(display, window, &title) != 0 && title != nullptr) {
    std::string result(title);
    XFree(title);
    return result;
  }
  return {};
}

std::string WindowClass(Display* display, Window window) {
  XClassHint hint{};
  if (XGetClassHint(display, window, &hint) == 0) return {};
  std::string result = hint.res_class != nullptr ? hint.res_class : (hint.res_name != nullptr ? hint.res_name : "");
  if (hint.res_name != nullptr) XFree(hint.res_name);
  if (hint.res_class != nullptr) XFree(hint.res_class);
  return result;
}

std::optional<Rect> WindowBounds(Display* display, Window window) {
  XWindowAttributes attributes{};
  if (!GetWindowAttributesSafely(display, window, &attributes) || attributes.map_state != IsViewable) return std::nullopt;
  Window child = None;
  int root_x = 0;
  int root_y = 0;
  if (XTranslateCoordinates(display, window, DefaultRootWindow(display), 0, 0, &root_x, &root_y, &child) == 0) return std::nullopt;
  return Rect{root_x, root_y, static_cast<unsigned int>(attributes.width), static_cast<unsigned int>(attributes.height)};
}

std::vector<Window> ClientWindows(Display* display) {
  const Window root = DefaultRootWindow(display);
  const auto data = ReadProperty(display, root, Intern(display, "_NET_CLIENT_LIST_STACKING"), XA_WINDOW);
  if (!data.empty()) {
    const auto* values = reinterpret_cast<const unsigned long*>(data.data());
    const size_t count = data.size() / sizeof(unsigned long);
    return std::vector<Window>(values, values + count);
  }

  Window returned_root = None;
  Window returned_parent = None;
  Window* children = nullptr;
  unsigned int count = 0;
  if (XQueryTree(display, root, &returned_root, &returned_parent, &children, &count) == 0) return {};
  std::vector<Window> result(children, children + count);
  if (children != nullptr) XFree(children);
  return result;
}

Window ActiveWindow(Display* display) {
  const auto data = ReadProperty(display, DefaultRootWindow(display), Intern(display, "_NET_ACTIVE_WINDOW"), XA_WINDOW);
  if (data.size() < sizeof(unsigned long)) return None;
  return static_cast<Window>(*reinterpret_cast<const unsigned long*>(data.data()));
}

std::optional<ParentInfo> FindParent(Display* display, const WindowQuery& query) {
  const Window active = ActiveWindow(display);
  std::optional<ParentInfo> topmost;
  std::optional<ParentInfo> largest;
  uint64_t largest_area = 0;
  for (const Window candidate : ClientWindows(display)) {
    const auto bounds = WindowBounds(display, candidate);
    if (!bounds) continue;
    const std::string title = WindowTitle(display, candidate);
    const std::string class_name = WindowClass(display, candidate);
    if (!Matches(title, query.title, query.exact)) continue;
    if (!query.class_name.empty() && !Matches(class_name, query.class_name, query.exact)) continue;

    ParentInfo info{candidate, title, class_name, *bounds};
    if (candidate == active) return info;
    topmost = info;
    const uint64_t area = static_cast<uint64_t>(bounds->width) * bounds->height;
    if (area > largest_area) {
      largest_area = area;
      largest = info;
    }
  }
  return topmost ? topmost : largest;
}

WindowQuery ReadQuery(const Napi::Value& value, const char* context) {
  if (!value.IsObject()) throw Napi::TypeError::New(value.Env(), std::string(context) + " must be an object.");
  const Napi::Object object = value.As<Napi::Object>();
  const Napi::Value title = object.Get("title");
  if (!title.IsString() || title.As<Napi::String>().Utf8Value().empty()) {
    throw Napi::TypeError::New(value.Env(), std::string(context) + ".title must be a non-empty string.");
  }
  WindowQuery query;
  query.title = title.As<Napi::String>().Utf8Value();
  const Napi::Value match = object.Get("match");
  if (match.IsString()) {
    const std::string mode = match.As<Napi::String>().Utf8Value();
    if (mode != "exact" && mode != "contains") {
      throw Napi::RangeError::New(value.Env(), std::string(context) + ".match must be 'exact' or 'contains'.");
    }
    query.exact = mode == "exact";
  }
  const Napi::Value class_name = object.Get("className");
  if (class_name.IsString()) query.class_name = class_name.As<Napi::String>().Utf8Value();
  return query;
}

Rect ReadRect(const Napi::Value& value, const char* context) {
  if (!value.IsObject()) throw Napi::TypeError::New(value.Env(), std::string(context) + " must be an object.");
  const Napi::Object object = value.As<Napi::Object>();
  const int width = object.Get("width").As<Napi::Number>().Int32Value();
  const int height = object.Get("height").As<Napi::Number>().Int32Value();
  if (width <= 0 || height <= 0) throw Napi::RangeError::New(value.Env(), std::string(context) + " dimensions must be positive.");
  return Rect{object.Get("x").As<Napi::Number>().Int32Value(), object.Get("y").As<Napi::Number>().Int32Value(),
              static_cast<unsigned int>(width), static_cast<unsigned int>(height)};
}

bool BooleanOption(const Napi::Object& object, const char* name, bool default_value) {
  const Napi::Value value = object.Get(name);
  return value.IsBoolean() ? value.As<Napi::Boolean>().Value() : default_value;
}

Napi::Object RectObject(Napi::Env env, const Rect& rect) {
  Napi::Object result = Napi::Object::New(env);
  result.Set("x", rect.x);
  result.Set("y", rect.y);
  result.Set("width", rect.width);
  result.Set("height", rect.height);
  return result;
}

Napi::Object ParentObject(Napi::Env env, const ParentInfo& parent) {
  Napi::Object result = Napi::Object::New(env);
  result.Set("xid", Napi::BigInt::New(env, static_cast<uint64_t>(parent.window)));
  result.Set("title", parent.title);
  result.Set("className", parent.class_name);
  result.Set("bounds", RectObject(env, parent.bounds));
  return result;
}

void ChangeAtomState(Display* display, Window window, Atom atom, bool enabled) {
  const Atom state_property = Intern(display, "_NET_WM_STATE");
  XWindowAttributes attributes{};
  if (!GetWindowAttributesSafely(display, window, &attributes)) return;
  if (attributes.map_state == IsViewable) {
    XEvent event{};
    event.xclient.type = ClientMessage;
    event.xclient.window = window;
    event.xclient.message_type = state_property;
    event.xclient.format = 32;
    event.xclient.data.l[0] = enabled ? 1 : 0;
    event.xclient.data.l[1] = static_cast<long>(atom);
    event.xclient.data.l[3] = 1;
    XSendEvent(display, DefaultRootWindow(display), False, SubstructureRedirectMask | SubstructureNotifyMask, &event);
    return;
  }

  const auto raw = ReadProperty(display, window, state_property, XA_ATOM);
  const auto* values = reinterpret_cast<const unsigned long*>(raw.data());
  std::vector<Atom> states(values, values + raw.size() / sizeof(unsigned long));
  const auto found = std::find(states.begin(), states.end(), atom);
  if (enabled && found == states.end()) states.push_back(atom);
  if (!enabled && found != states.end()) states.erase(found);
  XChangeProperty(display, window, state_property, XA_ATOM, 32, PropModeReplace,
                  reinterpret_cast<const unsigned char*>(states.data()), static_cast<int>(states.size()));
}

class X11Overlay : public Napi::ObjectWrap<X11Overlay> {
 public:
  struct Init {
    Display* display;
    Window overlay;
    Config config;
  };

  static Napi::FunctionReference constructor;

  static void Initialize(Napi::Env env, Napi::Object exports) {
    Napi::Function function = DefineClass(env, "X11Overlay", {
      InstanceMethod("attachParent", &X11Overlay::AttachParent), InstanceMethod("detachParent", &X11Overlay::DetachParent),
      InstanceMethod("setBounds", &X11Overlay::SetBounds), InstanceMethod("useParentBounds", &X11Overlay::UseParentBounds),
      InstanceMethod("setClickThrough", &X11Overlay::SetClickThrough), InstanceMethod("setAlwaysOnTop", &X11Overlay::SetAlwaysOnTop),
      InstanceMethod("reapply", &X11Overlay::Reapply), InstanceMethod("getState", &X11Overlay::GetState),
      InstanceMethod("close", &X11Overlay::Close)
    });
    constructor = Napi::Persistent(function);
    constructor.SuppressDestruct();
  }

  explicit X11Overlay(const Napi::CallbackInfo& info) : Napi::ObjectWrap<X11Overlay>(info) {
    std::unique_ptr<Init> init(info[0].As<Napi::External<Init>>().Data());
    display_ = init->display;
    overlay_ = init->overlay;
    config_ = init->config;
    if (config_.parent_query) parent_ = FindParent(display_, *config_.parent_query);
    Apply(true);
  }

  ~X11Overlay() override { CloseNative(); }

 private:
  void EnsureOpen(Napi::Env env) const {
    if (closed_) throw Napi::Error::New(env, "The X11 overlay controller is closed.");
  }

  void Move(const Rect& bounds) {
    XMoveResizeWindow(display_, overlay_, bounds.x, bounds.y, bounds.width, bounds.height);
  }

  void ApplyInputShape() {
    int event_base = 0;
    int error_base = 0;
    if (!XFixesQueryExtension(display_, &event_base, &error_base)) {
      return;
    }
    if (config_.click_through) {
      XserverRegion empty = XFixesCreateRegion(display_, nullptr, 0);
      XFixesSetWindowShapeRegion(display_, overlay_, ShapeInput, 0, 0, empty);
      XFixesDestroyRegion(display_, empty);
    } else {
      XFixesSetWindowShapeRegion(display_, overlay_, ShapeInput, 0, 0, None);
    }
  }

  void Apply(bool position) {
    const Atom utility = Intern(display_, "_NET_WM_WINDOW_TYPE_UTILITY");
    XChangeProperty(display_, overlay_, Intern(display_, "_NET_WM_WINDOW_TYPE"), XA_ATOM, 32, PropModeReplace,
                    reinterpret_cast<const unsigned char*>(&utility), 1);

    XWMHints* hints = XGetWMHints(display_, overlay_);
    if (hints == nullptr) hints = XAllocWMHints();
    if (hints != nullptr) {
      hints->flags |= InputHint;
      hints->input = False;
      XSetWMHints(display_, overlay_, hints);
      XFree(hints);
    }
    const unsigned long user_time = 0;
    XChangeProperty(display_, overlay_, Intern(display_, "_NET_WM_USER_TIME"), XA_CARDINAL, 32, PropModeReplace,
                    reinterpret_cast<const unsigned char*>(&user_time), 1);

    if (parent_) XSetTransientForHint(display_, overlay_, parent_->window);
    else XDeleteProperty(display_, overlay_, XA_WM_TRANSIENT_FOR);

    ChangeAtomState(display_, overlay_, Intern(display_, "_NET_WM_STATE_ABOVE"), config_.always_on_top);
    ChangeAtomState(display_, overlay_, Intern(display_, "_NET_WM_STATE_SKIP_TASKBAR"), true);
    ChangeAtomState(display_, overlay_, Intern(display_, "_NET_WM_STATE_SKIP_PAGER"), true);
    ChangeAtomState(display_, overlay_, Intern(display_, "_NET_WM_STATE_STICKY"), config_.all_workspaces);

    if (config_.preserve_compositing) {
      const unsigned long preference = 2;
      XChangeProperty(display_, overlay_, Intern(display_, "_NET_WM_BYPASS_COMPOSITOR"), XA_CARDINAL, 32, PropModeReplace,
                      reinterpret_cast<const unsigned char*>(&preference), 1);
    } else {
      XDeleteProperty(display_, overlay_, Intern(display_, "_NET_WM_BYPASS_COMPOSITOR"));
    }

    ApplyInputShape();
    if (position) {
      if (config_.position_parent && parent_) Move(parent_->bounds);
      else if (config_.bounds) Move(*config_.bounds);
    }
    if (parent_ || config_.always_on_top) XRaiseWindow(display_, overlay_);
    XFlush(display_);
  }

  Napi::Value AttachParent(const Napi::CallbackInfo& info) {
    EnsureOpen(info.Env());
    const WindowQuery query = ReadQuery(info[0], "query");
    const auto parent = FindParent(display_, query);
    if (!parent) return info.Env().Null();
    parent_ = parent;
    config_.parent_query = query;
    bool reposition = false;
    if (info.Length() > 1 && info[1].IsObject()) reposition = BooleanOption(info[1].As<Napi::Object>(), "reposition", false);
    XSetTransientForHint(display_, overlay_, parent_->window);
    if (reposition) Move(parent_->bounds);
    Apply(false);
    return ParentObject(info.Env(), *parent_);
  }

  void DetachParent(const Napi::CallbackInfo& info) {
    EnsureOpen(info.Env());
    parent_.reset();
    config_.parent_query.reset();
    XDeleteProperty(display_, overlay_, XA_WM_TRANSIENT_FOR);
    XFlush(display_);
  }

  void SetBounds(const Napi::CallbackInfo& info) {
    EnsureOpen(info.Env());
    config_.bounds = ReadRect(info[0], "bounds");
    config_.position_parent = false;
    Move(*config_.bounds);
    XFlush(display_);
  }

  Napi::Value UseParentBounds(const Napi::CallbackInfo& info) {
    EnsureOpen(info.Env());
    config_.position_parent = true;
    if (!parent_) return Napi::Boolean::New(info.Env(), false);
    const auto bounds = WindowBounds(display_, parent_->window);
    if (!bounds) return Napi::Boolean::New(info.Env(), false);
    parent_->bounds = *bounds;
    Move(*bounds);
    XFlush(display_);
    return Napi::Boolean::New(info.Env(), true);
  }

  void SetClickThrough(const Napi::CallbackInfo& info) {
    EnsureOpen(info.Env());
    config_.click_through = info[0].ToBoolean().Value();
    ApplyInputShape();
    XFlush(display_);
  }

  void SetAlwaysOnTop(const Napi::CallbackInfo& info) {
    EnsureOpen(info.Env());
    config_.always_on_top = info[0].ToBoolean().Value();
    ChangeAtomState(display_, overlay_, Intern(display_, "_NET_WM_STATE_ABOVE"), config_.always_on_top);
    if (config_.always_on_top) XRaiseWindow(display_, overlay_);
    XFlush(display_);
  }

  void Reapply(const Napi::CallbackInfo& info) { EnsureOpen(info.Env()); Apply(false); }

  Napi::Value GetState(const Napi::CallbackInfo& info) {
    Napi::Object state = Napi::Object::New(info.Env());
    state.Set("overlayXid", Napi::BigInt::New(info.Env(), static_cast<uint64_t>(overlay_)));
    if (parent_) state.Set("parent", ParentObject(info.Env(), *parent_));
    else state.Set("parent", info.Env().Null());
    Rect bounds{};
    if (!closed_) {
      const auto current = WindowBounds(display_, overlay_);
      if (current) bounds = *current;
    }
    state.Set("bounds", RectObject(info.Env(), bounds));
    state.Set("position", config_.position_parent ? "parent" : "bounds");
    state.Set("clickThrough", config_.click_through);
    state.Set("alwaysOnTop", config_.always_on_top);
    state.Set("preserveCompositing", config_.preserve_compositing);
    state.Set("allWorkspaces", config_.all_workspaces);
    state.Set("closed", closed_);
    return state;
  }

  void Close(const Napi::CallbackInfo&) { CloseNative(); }

  void CloseNative() {
    if (closed_) return;
    closed_ = true;
    if (display_ != nullptr) XCloseDisplay(display_);
    display_ = nullptr;
  }

  Display* display_ = nullptr;
  Window overlay_ = None;
  Config config_;
  std::optional<ParentInfo> parent_;
  bool closed_ = false;
};

Napi::FunctionReference X11Overlay::constructor;

Window ReadNativeHandle(const Napi::Value& value) {
  if (!value.IsBuffer()) throw Napi::TypeError::New(value.Env(), "nativeWindowHandle must be a Buffer.");
  const Napi::Buffer<uint8_t> buffer = value.As<Napi::Buffer<uint8_t>>();
  if (buffer.Length() == 0) throw Napi::RangeError::New(value.Env(), "nativeWindowHandle is empty.");
  uintptr_t native_handle = 0;
  std::memcpy(&native_handle, buffer.Data(), std::min(buffer.Length(), sizeof(native_handle)));
  return static_cast<Window>(native_handle);
}

Config ReadConfig(const Napi::Value& value) {
  if (!value.IsObject()) throw Napi::TypeError::New(value.Env(), "options must be an object.");
  const Napi::Object object = value.As<Napi::Object>();
  Config config;
  const Napi::Value position = object.Get("position");
  if (!position.IsString()) throw Napi::TypeError::New(value.Env(), "options.position must be a string.");
  const std::string position_name = position.As<Napi::String>().Utf8Value();
  if (position_name != "bounds" && position_name != "parent") {
    throw Napi::RangeError::New(value.Env(), "options.position must be 'bounds' or 'parent'.");
  }
  config.position_parent = position_name == "parent";
  const Napi::Value bounds = object.Get("bounds");
  if (bounds.IsObject()) config.bounds = ReadRect(bounds, "options.bounds");
  if (!config.position_parent && !config.bounds) throw Napi::TypeError::New(value.Env(), "options.bounds is required for bounds positioning.");
  const Napi::Value parent = object.Get("parent");
  if (parent.IsObject()) config.parent_query = ReadQuery(parent, "options.parent");
  config.click_through = BooleanOption(object, "clickThrough", true);
  config.always_on_top = BooleanOption(object, "alwaysOnTop", true);
  config.preserve_compositing = BooleanOption(object, "preserveCompositing", true);
  config.all_workspaces = BooleanOption(object, "allWorkspaces", false);
  return config;
}

Napi::Value Configure(const Napi::CallbackInfo& info) {
  const Window overlay = ReadNativeHandle(info[0]);
  Config config = ReadConfig(info[1]);
  Display* display = XOpenDisplay(nullptr);
  if (display == nullptr) throw Napi::Error::New(info.Env(), "Could not open the X11 display. Run Electron through X11/XWayland.");
  XWindowAttributes attributes{};
  if (overlay == None || !GetWindowAttributesSafely(display, overlay, &attributes)) {
    XCloseDisplay(display);
    throw Napi::Error::New(info.Env(), "The native handle is not a valid X11 BrowserWindow.");
  }
  if (config.click_through) {
    int event_base = 0;
    int error_base = 0;
    if (!XFixesQueryExtension(display, &event_base, &error_base)) {
      XCloseDisplay(display);
      throw Napi::Error::New(info.Env(), "The XFixes extension is required for click-through overlays.");
    }
  }
  auto* init = new X11Overlay::Init{display, overlay, std::move(config)};
  return X11Overlay::constructor.New({Napi::External<X11Overlay::Init>::New(info.Env(), init)});
}

Napi::Value FindWindow(const Napi::CallbackInfo& info) {
  const WindowQuery query = ReadQuery(info[0], "query");
  Display* display = XOpenDisplay(nullptr);
  if (display == nullptr) throw Napi::Error::New(info.Env(), "Could not open the X11 display.");
  const auto parent = FindParent(display, query);
  XCloseDisplay(display);
  return parent ? ParentObject(info.Env(), *parent) : info.Env().Null();
}

Napi::Object Initialize(Napi::Env env, Napi::Object exports) {
  X11Overlay::Initialize(env, exports);
  exports.Set("configure", Napi::Function::New(env, Configure));
  exports.Set("findWindow", Napi::Function::New(env, FindWindow));
  return exports;
}

}  // namespace

#else

namespace {
Napi::Value Unsupported(const Napi::CallbackInfo& info) {
  throw Napi::Error::New(info.Env(), "This addon supports Linux X11/XWayland only.");
}
Napi::Object Initialize(Napi::Env env, Napi::Object exports) {
  exports.Set("configure", Napi::Function::New(env, Unsupported));
  exports.Set("findWindow", Napi::Function::New(env, Unsupported));
  return exports;
}
}  // namespace

#endif

NODE_API_MODULE(x11_overlay, Initialize)
