#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <algorithm>
#include <cstdint>
#include <cstring>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>

#include <napi.h>

namespace {

struct Rect {
  int x = 0;
  int y = 0;
  unsigned int width = 1;
  unsigned int height = 1;
};

struct WindowQuery {
  std::wstring title;
  std::wstring class_name;
  bool exact = false;
};

struct ParentInfo {
  HWND window = nullptr;
  std::wstring title;
  std::wstring class_name;
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

std::wstring Utf8ToWide(const std::string& value) {
  if (value.empty()) return {};
  const int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                                         static_cast<int>(value.size()), nullptr, 0);
  if (length == 0) throw std::runtime_error("Could not convert a UTF-8 string for Win32.");
  std::wstring result(static_cast<size_t>(length), L'\0');
  MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()),
                      result.data(), length);
  return result;
}

std::string WideToUtf8(const std::wstring& value) {
  if (value.empty()) return {};
  const int length = WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()),
                                         nullptr, 0, nullptr, nullptr);
  if (length == 0) return {};
  std::string result(static_cast<size_t>(length), '\0');
  WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), result.data(),
                      length, nullptr, nullptr);
  return result;
}

std::wstring Lower(std::wstring value) {
  if (value.empty()) return value;
  const int length = LCMapStringEx(LOCALE_NAME_INVARIANT, LCMAP_LOWERCASE, value.data(),
                                   static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr, 0);
  if (length == 0) return value;
  std::wstring result(static_cast<size_t>(length), L'\0');
  LCMapStringEx(LOCALE_NAME_INVARIANT, LCMAP_LOWERCASE, value.data(),
                static_cast<int>(value.size()), result.data(), length, nullptr, nullptr, 0);
  return result;
}

bool Matches(const std::wstring& value, const std::wstring& expected, bool exact) {
  const std::wstring lowered_value = Lower(value);
  const std::wstring lowered_expected = Lower(expected);
  return exact ? lowered_value == lowered_expected
               : lowered_value.find(lowered_expected) != std::wstring::npos;
}

std::wstring WindowTitle(HWND window) {
  const int length = GetWindowTextLengthW(window);
  if (length <= 0) return {};
  std::wstring result(static_cast<size_t>(length) + 1, L'\0');
  const int copied = GetWindowTextW(window, result.data(), static_cast<int>(result.size()));
  result.resize(copied > 0 ? static_cast<size_t>(copied) : 0);
  return result;
}

std::wstring WindowClass(HWND window) {
  std::wstring result(256, L'\0');
  for (;;) {
    const int copied = GetClassNameW(window, result.data(), static_cast<int>(result.size()));
    if (copied <= 0) return {};
    if (copied < static_cast<int>(result.size()) - 1 || result.size() >= 32768) {
      result.resize(static_cast<size_t>(copied));
      return result;
    }
    result.resize(result.size() * 2);
  }
}

std::optional<Rect> WindowBounds(HWND window) {
  if (!IsWindow(window)) return std::nullopt;
  RECT client{};
  POINT origin{};
  if (!GetClientRect(window, &client) || !ClientToScreen(window, &origin)) return std::nullopt;
  const LONG width = client.right - client.left;
  const LONG height = client.bottom - client.top;
  if (width <= 0 || height <= 0) return std::nullopt;
  return Rect{origin.x, origin.y, static_cast<unsigned int>(width),
              static_cast<unsigned int>(height)};
}

struct FindContext {
  const WindowQuery* query = nullptr;
  HWND active = nullptr;
  std::optional<ParentInfo> active_match;
  std::optional<ParentInfo> topmost_match;
};

BOOL CALLBACK FindWindowCallback(HWND candidate, LPARAM parameter) {
  auto* context = reinterpret_cast<FindContext*>(parameter);
  if (!IsWindowVisible(candidate)) return TRUE;
  const auto bounds = WindowBounds(candidate);
  if (!bounds) return TRUE;
  const std::wstring title = WindowTitle(candidate);
  const std::wstring class_name = WindowClass(candidate);
  if (!Matches(title, context->query->title, context->query->exact)) return TRUE;
  if (!context->query->class_name.empty() &&
      !Matches(class_name, context->query->class_name, context->query->exact)) {
    return TRUE;
  }

  ParentInfo info{candidate, title, class_name, *bounds};
  if (candidate == context->active) {
    context->active_match = std::move(info);
    return FALSE;
  }
  // EnumWindows visits top-level windows from top to bottom in Z order.
  if (!context->topmost_match) context->topmost_match = std::move(info);
  return TRUE;
}

std::optional<ParentInfo> FindParent(const WindowQuery& query) {
  FindContext context{&query, GetForegroundWindow(), std::nullopt, std::nullopt};
  EnumWindows(FindWindowCallback, reinterpret_cast<LPARAM>(&context));
  return context.active_match ? context.active_match : context.topmost_match;
}

WindowQuery ReadQuery(const Napi::Value& value, const char* context) {
  if (!value.IsObject()) {
    throw Napi::TypeError::New(value.Env(), std::string(context) + " must be an object.");
  }
  const Napi::Object object = value.As<Napi::Object>();
  const Napi::Value title = object.Get("title");
  if (!title.IsString() || title.As<Napi::String>().Utf8Value().empty()) {
    throw Napi::TypeError::New(value.Env(),
                               std::string(context) + ".title must be a non-empty string.");
  }
  WindowQuery query;
  query.title = Utf8ToWide(title.As<Napi::String>().Utf8Value());
  const Napi::Value match = object.Get("match");
  if (match.IsString()) {
    const std::string mode = match.As<Napi::String>().Utf8Value();
    if (mode != "exact" && mode != "contains") {
      throw Napi::RangeError::New(
          value.Env(), std::string(context) + ".match must be 'exact' or 'contains'.");
    }
    query.exact = mode == "exact";
  }
  const Napi::Value class_name = object.Get("className");
  if (class_name.IsString()) {
    query.class_name = Utf8ToWide(class_name.As<Napi::String>().Utf8Value());
  }
  return query;
}

Rect ReadRect(const Napi::Value& value, const char* context) {
  if (!value.IsObject()) {
    throw Napi::TypeError::New(value.Env(), std::string(context) + " must be an object.");
  }
  const Napi::Object object = value.As<Napi::Object>();
  const int width = object.Get("width").As<Napi::Number>().Int32Value();
  const int height = object.Get("height").As<Napi::Number>().Int32Value();
  if (width <= 0 || height <= 0) {
    throw Napi::RangeError::New(value.Env(),
                                std::string(context) + " dimensions must be positive.");
  }
  return Rect{object.Get("x").As<Napi::Number>().Int32Value(),
              object.Get("y").As<Napi::Number>().Int32Value(),
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
  result.Set("xid", Napi::BigInt::New(
                        env, static_cast<uint64_t>(reinterpret_cast<uintptr_t>(parent.window))));
  result.Set("title", WideToUtf8(parent.title));
  result.Set("className", WideToUtf8(parent.class_name));
  result.Set("bounds", RectObject(env, parent.bounds));
  return result;
}

void SetOwner(HWND window, HWND owner, Napi::Env env) {
  SetLastError(ERROR_SUCCESS);
  const LONG_PTR previous =
      SetWindowLongPtrW(window, GWLP_HWNDPARENT, reinterpret_cast<LONG_PTR>(owner));
  if (previous == 0 && GetLastError() != ERROR_SUCCESS) {
    throw Napi::Error::New(env, "Could not update the overlay owner window.");
  }
}

class Win32Overlay : public Napi::ObjectWrap<Win32Overlay> {
 public:
  struct Init {
    HWND overlay;
    Config config;
  };

  static Napi::FunctionReference constructor;

  static void Initialize(Napi::Env env, Napi::Object) {
    Napi::Function function = DefineClass(
        env, "Win32Overlay",
        {InstanceMethod("attachParent", &Win32Overlay::AttachParent),
         InstanceMethod("detachParent", &Win32Overlay::DetachParent),
         InstanceMethod("setBounds", &Win32Overlay::SetBounds),
         InstanceMethod("useParentBounds", &Win32Overlay::UseParentBounds),
         InstanceMethod("setClickThrough", &Win32Overlay::SetClickThrough),
         InstanceMethod("setAlwaysOnTop", &Win32Overlay::SetAlwaysOnTop),
         InstanceMethod("reapply", &Win32Overlay::Reapply),
         InstanceMethod("getState", &Win32Overlay::GetState),
         InstanceMethod("close", &Win32Overlay::Close)});
    constructor = Napi::Persistent(function);
    constructor.SuppressDestruct();
  }

  explicit Win32Overlay(const Napi::CallbackInfo& info) : Napi::ObjectWrap<Win32Overlay>(info) {
    std::unique_ptr<Init> init(info[0].As<Napi::External<Init>>().Data());
    overlay_ = init->overlay;
    config_ = std::move(init->config);
    if (config_.parent_query) parent_ = FindParent(*config_.parent_query);
    Apply(true, info.Env());
  }

 private:
  void EnsureOpen(Napi::Env env) const {
    if (closed_) throw Napi::Error::New(env, "The Win32 overlay controller is closed.");
    if (!IsWindow(overlay_)) {
      throw Napi::Error::New(env, "The Win32 BrowserWindow handle is no longer valid.");
    }
  }

  void Move(const Rect& bounds, Napi::Env env) {
    const HWND placement = config_.always_on_top ? HWND_TOPMOST : HWND_NOTOPMOST;
    if (!SetWindowPos(overlay_, placement, bounds.x, bounds.y, static_cast<int>(bounds.width),
                      static_cast<int>(bounds.height), SWP_NOACTIVATE)) {
      throw Napi::Error::New(env, "Could not position the Win32 overlay window.");
    }
  }

  void ApplyStyles(Napi::Env env) {
    SetLastError(ERROR_SUCCESS);
    LONG_PTR styles = GetWindowLongPtrW(overlay_, GWL_EXSTYLE);
    if (styles == 0 && GetLastError() != ERROR_SUCCESS) {
      throw Napi::Error::New(env, "Could not read the Win32 overlay window styles.");
    }
    styles |= WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
    styles &= ~static_cast<LONG_PTR>(WS_EX_APPWINDOW);
    if (config_.click_through) styles |= WS_EX_TRANSPARENT;
    else styles &= ~static_cast<LONG_PTR>(WS_EX_TRANSPARENT);

    SetLastError(ERROR_SUCCESS);
    const LONG_PTR previous = SetWindowLongPtrW(overlay_, GWL_EXSTYLE, styles);
    if (previous == 0 && GetLastError() != ERROR_SUCCESS) {
      throw Napi::Error::New(env, "Could not update the Win32 overlay window styles.");
    }
  }

  void ApplyZOrder(Napi::Env env, bool frame_changed) {
    UINT flags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE;
    if (frame_changed) flags |= SWP_FRAMECHANGED;
    const HWND placement = config_.always_on_top ? HWND_TOPMOST : HWND_NOTOPMOST;
    if (!SetWindowPos(overlay_, placement, 0, 0, 0, 0, flags)) {
      throw Napi::Error::New(env, "Could not update the Win32 overlay z-order.");
    }
  }

  void Apply(bool position, Napi::Env env) {
    EnsureOpen(env);
    ApplyStyles(env);
    if (parent_ && !IsWindow(parent_->window)) parent_.reset();
    SetOwner(overlay_, parent_ ? parent_->window : nullptr, env);

    if (position) {
      if (config_.position_parent && parent_) Move(parent_->bounds, env);
      else if (config_.bounds) Move(*config_.bounds, env);
    }
    ApplyZOrder(env, true);
  }

  Napi::Value AttachParent(const Napi::CallbackInfo& info) {
    EnsureOpen(info.Env());
    const WindowQuery query = ReadQuery(info[0], "query");
    const auto parent = FindParent(query);
    if (!parent) return info.Env().Null();
    parent_ = parent;
    config_.parent_query = query;
    bool reposition = false;
    if (info.Length() > 1 && info[1].IsObject()) {
      reposition = BooleanOption(info[1].As<Napi::Object>(), "reposition", false);
    }
    SetOwner(overlay_, parent_->window, info.Env());
    if (reposition) Move(parent_->bounds, info.Env());
    Apply(false, info.Env());
    return ParentObject(info.Env(), *parent_);
  }

  void DetachParent(const Napi::CallbackInfo& info) {
    EnsureOpen(info.Env());
    parent_.reset();
    config_.parent_query.reset();
    SetOwner(overlay_, nullptr, info.Env());
  }

  void SetBounds(const Napi::CallbackInfo& info) {
    EnsureOpen(info.Env());
    config_.bounds = ReadRect(info[0], "bounds");
    config_.position_parent = false;
    Move(*config_.bounds, info.Env());
  }

  Napi::Value UseParentBounds(const Napi::CallbackInfo& info) {
    EnsureOpen(info.Env());
    config_.position_parent = true;
    if (!parent_ || !IsWindow(parent_->window)) return Napi::Boolean::New(info.Env(), false);
    const auto bounds = WindowBounds(parent_->window);
    if (!bounds) return Napi::Boolean::New(info.Env(), false);
    parent_->bounds = *bounds;
    Move(*bounds, info.Env());
    return Napi::Boolean::New(info.Env(), true);
  }

  void SetClickThrough(const Napi::CallbackInfo& info) {
    EnsureOpen(info.Env());
    config_.click_through = info[0].ToBoolean().Value();
    ApplyStyles(info.Env());
    ApplyZOrder(info.Env(), true);
  }

  void SetAlwaysOnTop(const Napi::CallbackInfo& info) {
    EnsureOpen(info.Env());
    config_.always_on_top = info[0].ToBoolean().Value();
    ApplyZOrder(info.Env(), false);
  }

  void Reapply(const Napi::CallbackInfo& info) {
    EnsureOpen(info.Env());
    Apply(false, info.Env());
  }

  Napi::Value GetState(const Napi::CallbackInfo& info) {
    Napi::Object state = Napi::Object::New(info.Env());
    state.Set("overlayXid",
              Napi::BigInt::New(info.Env(),
                                static_cast<uint64_t>(reinterpret_cast<uintptr_t>(overlay_))));
    if (parent_) state.Set("parent", ParentObject(info.Env(), *parent_));
    else state.Set("parent", info.Env().Null());
    Rect bounds{};
    if (!closed_) {
      const auto current = WindowBounds(overlay_);
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

  void Close(const Napi::CallbackInfo&) { closed_ = true; }

  HWND overlay_ = nullptr;
  Config config_;
  std::optional<ParentInfo> parent_;
  bool closed_ = false;
};

Napi::FunctionReference Win32Overlay::constructor;

HWND ReadNativeHandle(const Napi::Value& value) {
  if (!value.IsBuffer()) {
    throw Napi::TypeError::New(value.Env(), "nativeWindowHandle must be a Buffer.");
  }
  const Napi::Buffer<uint8_t> buffer = value.As<Napi::Buffer<uint8_t>>();
  if (buffer.Length() == 0) {
    throw Napi::RangeError::New(value.Env(), "nativeWindowHandle is empty.");
  }
  uintptr_t native_handle = 0;
  std::memcpy(&native_handle, buffer.Data(), std::min(buffer.Length(), sizeof(native_handle)));
  return reinterpret_cast<HWND>(native_handle);
}

Config ReadConfig(const Napi::Value& value) {
  if (!value.IsObject()) throw Napi::TypeError::New(value.Env(), "options must be an object.");
  const Napi::Object object = value.As<Napi::Object>();
  Config config;
  const Napi::Value position = object.Get("position");
  if (!position.IsString()) {
    throw Napi::TypeError::New(value.Env(), "options.position must be a string.");
  }
  const std::string position_name = position.As<Napi::String>().Utf8Value();
  if (position_name != "bounds" && position_name != "parent") {
    throw Napi::RangeError::New(value.Env(),
                                "options.position must be 'bounds' or 'parent'.");
  }
  config.position_parent = position_name == "parent";
  const Napi::Value bounds = object.Get("bounds");
  if (bounds.IsObject()) config.bounds = ReadRect(bounds, "options.bounds");
  if (!config.position_parent && !config.bounds) {
    throw Napi::TypeError::New(value.Env(),
                               "options.bounds is required for bounds positioning.");
  }
  const Napi::Value parent = object.Get("parent");
  if (parent.IsObject()) config.parent_query = ReadQuery(parent, "options.parent");
  config.click_through = BooleanOption(object, "clickThrough", true);
  config.always_on_top = BooleanOption(object, "alwaysOnTop", true);
  config.preserve_compositing = BooleanOption(object, "preserveCompositing", true);
  config.all_workspaces = BooleanOption(object, "allWorkspaces", false);
  return config;
}

Napi::Value Configure(const Napi::CallbackInfo& info) {
  const HWND overlay = ReadNativeHandle(info[0]);
  Config config = ReadConfig(info[1]);
  if (overlay == nullptr || !IsWindow(overlay)) {
    throw Napi::Error::New(info.Env(),
                           "The native handle is not a valid Win32 BrowserWindow HWND.");
  }
  auto* init = new Win32Overlay::Init{overlay, std::move(config)};
  return Win32Overlay::constructor.New(
      {Napi::External<Win32Overlay::Init>::New(info.Env(), init)});
}

Napi::Value FindWindow(const Napi::CallbackInfo& info) {
  const WindowQuery query = ReadQuery(info[0], "query");
  const auto parent = FindParent(query);
  return parent ? ParentObject(info.Env(), *parent) : info.Env().Null();
}

Napi::Object Initialize(Napi::Env env, Napi::Object exports) {
  Win32Overlay::Initialize(env, exports);
  exports.Set("configure", Napi::Function::New(env, Configure));
  exports.Set("findWindow", Napi::Function::New(env, FindWindow));
  return exports;
}

}  // namespace

NODE_API_MODULE(x11_overlay, Initialize)
