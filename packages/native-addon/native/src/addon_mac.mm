#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <memory>
#include <optional>
#include <string>

#include <AppKit/AppKit.h>
#include <ApplicationServices/ApplicationServices.h>
#include <napi.h>
#include <unistd.h>

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
  CGWindowID window = kCGNullWindowID;
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

std::string Utf8(NSString* value) {
  if (value == nil) return {};
  const char* utf8 = [value UTF8String];
  return utf8 == nullptr ? std::string() : std::string(utf8);
}

bool Matches(NSString* value, const std::string& expected, bool exact) {
  if (value == nil) return false;
  NSString* target = [NSString stringWithUTF8String:expected.c_str()];
  if (target == nil) return false;
  if (exact) return [value compare:target options:NSCaseInsensitiveSearch] == NSOrderedSame;
  return [value rangeOfString:target options:NSCaseInsensitiveSearch].location != NSNotFound;
}

std::optional<Rect> DictionaryBounds(NSDictionary* entry) {
  NSDictionary* dictionary = [entry objectForKey:(id)kCGWindowBounds];
  CGRect bounds = CGRectZero;
  if (dictionary == nil || !CGRectMakeWithDictionaryRepresentation((CFDictionaryRef)dictionary, &bounds) ||
      bounds.size.width <= 0 || bounds.size.height <= 0) {
    return std::nullopt;
  }
  return Rect{static_cast<int>(std::lround(bounds.origin.x)), static_cast<int>(std::lround(bounds.origin.y)),
              static_cast<unsigned int>(std::lround(bounds.size.width)),
              static_cast<unsigned int>(std::lround(bounds.size.height))};
}

std::optional<ParentInfo> ParentFromDictionary(NSDictionary* entry) {
  NSNumber* number = [entry objectForKey:(id)kCGWindowNumber];
  NSString* title = [entry objectForKey:(id)kCGWindowName];
  NSString* owner = [entry objectForKey:(id)kCGWindowOwnerName];
  const auto bounds = DictionaryBounds(entry);
  if (number == nil || !bounds) return std::nullopt;
  return ParentInfo{static_cast<CGWindowID>([number unsignedIntValue]), Utf8(title), Utf8(owner), *bounds};
}

std::optional<ParentInfo> FindParent(const WindowQuery& query) {
  CGWindowListOption options = static_cast<CGWindowListOption>(
      kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements);
  CFArrayRef window_info = CGWindowListCopyWindowInfo(options, kCGNullWindowID);
  if (window_info == nullptr) return std::nullopt;

  std::optional<ParentInfo> result;
  for (NSDictionary* entry in (NSArray*)window_info) {
    NSNumber* owner_pid = [entry objectForKey:(id)kCGWindowOwnerPID];
    NSNumber* layer = [entry objectForKey:(id)kCGWindowLayer];
    NSString* title = [entry objectForKey:(id)kCGWindowName];
    NSString* owner = [entry objectForKey:(id)kCGWindowOwnerName];
    if (owner_pid == nil || [owner_pid intValue] == getpid() || layer == nil || [layer intValue] != 0) continue;
    if (!Matches(title, query.title, query.exact)) continue;
    if (!query.class_name.empty() && !Matches(owner, query.class_name, query.exact)) continue;
    result = ParentFromDictionary(entry);
    if (result) break;  // CoreGraphics returns the on-screen list frontmost first.
  }
  CFRelease(window_info);
  return result;
}

std::optional<Rect> WindowBounds(CGWindowID window) {
  CFArrayRef window_info = CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow, window);
  if (window_info == nullptr) return std::nullopt;
  std::optional<Rect> result;
  NSArray* entries = (NSArray*)window_info;
  if ([entries count] != 0) result = DictionaryBounds([entries objectAtIndex:0]);
  CFRelease(window_info);
  return result;
}

CGFloat CocoaReferenceTop() {
  NSArray* screens = [NSScreen screens];
  if ([screens count] == 0) return 0;
  return NSMaxY([[screens objectAtIndex:0] frame]);
}

NSRect CocoaFrame(const Rect& bounds) {
  return NSMakeRect(bounds.x, CocoaReferenceTop() - bounds.y - bounds.height, bounds.width, bounds.height);
}

Rect ElectronBounds(NSRect frame) {
  return Rect{static_cast<int>(std::lround(NSMinX(frame))),
              static_cast<int>(std::lround(CocoaReferenceTop() - NSMaxY(frame))),
              static_cast<unsigned int>(std::lround(NSWidth(frame))),
              static_cast<unsigned int>(std::lround(NSHeight(frame)))};
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
  if (width <= 0 || height <= 0) {
    throw Napi::RangeError::New(value.Env(), std::string(context) + " dimensions must be positive.");
  }
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

void EnsureMainThread(Napi::Env env) {
  if (![NSThread isMainThread]) throw Napi::Error::New(env, "macOS overlay operations must run on the main thread.");
}

class MacOverlay : public Napi::ObjectWrap<MacOverlay> {
 public:
  struct Init {
    NSWindow* overlay;
    CGWindowID overlay_window_id;
    Config config;
  };

  static Napi::FunctionReference constructor;

  static void Initialize(Napi::Env env, Napi::Object) {
    Napi::Function function = DefineClass(env, "MacOverlay", {
      InstanceMethod("attachParent", &MacOverlay::AttachParent), InstanceMethod("detachParent", &MacOverlay::DetachParent),
      InstanceMethod("setBounds", &MacOverlay::SetBounds), InstanceMethod("useParentBounds", &MacOverlay::UseParentBounds),
      InstanceMethod("setClickThrough", &MacOverlay::SetClickThrough),
      InstanceMethod("setAlwaysOnTop", &MacOverlay::SetAlwaysOnTop), InstanceMethod("reapply", &MacOverlay::Reapply),
      InstanceMethod("getState", &MacOverlay::GetState), InstanceMethod("close", &MacOverlay::Close)
    });
    constructor = Napi::Persistent(function);
    constructor.SuppressDestruct();
  }

  explicit MacOverlay(const Napi::CallbackInfo& info) : Napi::ObjectWrap<MacOverlay>(info) {
    std::unique_ptr<Init> init(info[0].As<Napi::External<Init>>().Data());
    overlay_ = init->overlay;
    [overlay_ retain];
    overlay_window_id_ = init->overlay_window_id;
    config_ = std::move(init->config);
    if (config_.parent_query) parent_ = FindParent(*config_.parent_query);
    Apply(true);
  }

  ~MacOverlay() override { CloseNative(); }

 private:
  void EnsureOpen(Napi::Env env) const {
    if (closed_) throw Napi::Error::New(env, "The macOS overlay controller is closed.");
  }

  void Move(const Rect& bounds) { [overlay_ setFrame:CocoaFrame(bounds) display:YES]; }

  void Apply(bool position) {
    [overlay_ setIgnoresMouseEvents:config_.click_through ? YES : NO];
    [overlay_ setLevel:config_.always_on_top ? NSFloatingWindowLevel : NSNormalWindowLevel];
    NSWindowCollectionBehavior behavior = [overlay_ collectionBehavior];
    if (config_.all_workspaces) behavior |= NSWindowCollectionBehaviorCanJoinAllSpaces;
    else behavior &= ~NSWindowCollectionBehaviorCanJoinAllSpaces;
    [overlay_ setCollectionBehavior:behavior];
    if (position) {
      if (config_.position_parent && parent_) Move(parent_->bounds);
      else if (config_.bounds) Move(*config_.bounds);
    }
    if (parent_ || config_.always_on_top) [overlay_ orderFrontRegardless];
  }

  Napi::Value AttachParent(const Napi::CallbackInfo& info) {
    EnsureOpen(info.Env());
    EnsureMainThread(info.Env());
    @autoreleasepool {
      const WindowQuery query = ReadQuery(info[0], "query");
      const auto parent = FindParent(query);
      if (!parent) return info.Env().Null();
      parent_ = parent;
      config_.parent_query = query;
      bool reposition = false;
      if (info.Length() > 1 && info[1].IsObject()) {
        reposition = BooleanOption(info[1].As<Napi::Object>(), "reposition", false);
      }
      if (reposition) Move(parent_->bounds);
      return ParentObject(info.Env(), *parent_);
    }
  }

  void DetachParent(const Napi::CallbackInfo& info) {
    EnsureOpen(info.Env());
    EnsureMainThread(info.Env());
    parent_.reset();
    config_.parent_query.reset();
  }

  void SetBounds(const Napi::CallbackInfo& info) {
    EnsureOpen(info.Env());
    EnsureMainThread(info.Env());
    config_.bounds = ReadRect(info[0], "bounds");
    config_.position_parent = false;
    Move(*config_.bounds);
  }

  Napi::Value UseParentBounds(const Napi::CallbackInfo& info) {
    EnsureOpen(info.Env());
    EnsureMainThread(info.Env());
    config_.position_parent = true;
    if (!parent_) return Napi::Boolean::New(info.Env(), false);
    const auto bounds = WindowBounds(parent_->window);
    if (!bounds) return Napi::Boolean::New(info.Env(), false);
    parent_->bounds = *bounds;
    Move(*bounds);
    return Napi::Boolean::New(info.Env(), true);
  }

  void SetClickThrough(const Napi::CallbackInfo& info) {
    EnsureOpen(info.Env());
    EnsureMainThread(info.Env());
    config_.click_through = info[0].ToBoolean().Value();
    [overlay_ setIgnoresMouseEvents:config_.click_through ? YES : NO];
  }

  void SetAlwaysOnTop(const Napi::CallbackInfo& info) {
    EnsureOpen(info.Env());
    EnsureMainThread(info.Env());
    config_.always_on_top = info[0].ToBoolean().Value();
    [overlay_ setLevel:config_.always_on_top ? NSFloatingWindowLevel : NSNormalWindowLevel];
    if (config_.always_on_top) [overlay_ orderFrontRegardless];
  }

  void Reapply(const Napi::CallbackInfo& info) {
    EnsureOpen(info.Env());
    EnsureMainThread(info.Env());
    Apply(false);
  }

  Napi::Value GetState(const Napi::CallbackInfo& info) {
    EnsureMainThread(info.Env());
    Napi::Object state = Napi::Object::New(info.Env());
    state.Set("overlayXid", Napi::BigInt::New(info.Env(), static_cast<uint64_t>(overlay_window_id_)));
    if (parent_) state.Set("parent", ParentObject(info.Env(), *parent_));
    else state.Set("parent", info.Env().Null());
    Rect bounds{};
    if (!closed_) bounds = ElectronBounds([overlay_ frame]);
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
    if (overlay_ != nil) [overlay_ release];
    overlay_ = nil;
  }

  NSWindow* overlay_ = nil;
  CGWindowID overlay_window_id_ = kCGNullWindowID;
  Config config_;
  std::optional<ParentInfo> parent_;
  bool closed_ = false;
};

Napi::FunctionReference MacOverlay::constructor;

NSView* ReadNativeHandle(const Napi::Value& value) {
  if (!value.IsBuffer()) throw Napi::TypeError::New(value.Env(), "nativeWindowHandle must be a Buffer.");
  const Napi::Buffer<uint8_t> buffer = value.As<Napi::Buffer<uint8_t>>();
  if (buffer.Length() == 0) throw Napi::RangeError::New(value.Env(), "nativeWindowHandle is empty.");
  uintptr_t native_handle = 0;
  std::memcpy(&native_handle, buffer.Data(), std::min(buffer.Length(), sizeof(native_handle)));
  return reinterpret_cast<NSView*>(native_handle);
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
  if (!config.position_parent && !config.bounds) {
    throw Napi::TypeError::New(value.Env(), "options.bounds is required for bounds positioning.");
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
  NSView* view = ReadNativeHandle(info[0]);
  Config config = ReadConfig(info[1]);
  EnsureMainThread(info.Env());
  @autoreleasepool {
    NSWindow* overlay = [view window];
    if (view == nil || overlay == nil) {
      throw Napi::Error::New(info.Env(), "The native handle is not a valid macOS BrowserWindow NSView.");
    }
    auto* init = new MacOverlay::Init{overlay, static_cast<CGWindowID>([overlay windowNumber]), std::move(config)};
    return MacOverlay::constructor.New({Napi::External<MacOverlay::Init>::New(info.Env(), init)});
  }
}

Napi::Value FindWindow(const Napi::CallbackInfo& info) {
  const WindowQuery query = ReadQuery(info[0], "query");
  @autoreleasepool {
    const auto parent = FindParent(query);
    return parent ? ParentObject(info.Env(), *parent) : info.Env().Null();
  }
}

Napi::Object Initialize(Napi::Env env, Napi::Object exports) {
  MacOverlay::Initialize(env, exports);
  exports.Set("configure", Napi::Function::New(env, Configure));
  exports.Set("findWindow", Napi::Function::New(env, FindWindow));
  return exports;
}

}  // namespace

NODE_API_MODULE(x11_overlay, Initialize)
