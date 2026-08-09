#include <napi.h>

#include <algorithm>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <memory>
#include <mutex>
#include <poll.h>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include <fcntl.h>
#include <sys/mman.h>
#include <sys/eventfd.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>
#include <wayland-client.h>

#include "wlr-layer-shell-unstable-v1-client-protocol.h"

namespace {

constexpr uint32_t kAllAnchors =
    ZWLR_LAYER_SURFACE_V1_ANCHOR_TOP |
    ZWLR_LAYER_SURFACE_V1_ANCHOR_BOTTOM |
    ZWLR_LAYER_SURFACE_V1_ANCHOR_LEFT |
    ZWLR_LAYER_SURFACE_V1_ANCHOR_RIGHT;

struct Output {
  uint32_t globalName = 0;
  wl_output* proxy = nullptr;
  std::string name;
  uint32_t width = 0;
  uint32_t height = 0;
  int32_t scale = 1;
};

class LayerShellController;

struct ShmBuffer {
  LayerShellController* owner = nullptr;
  wl_buffer* proxy = nullptr;
  void* data = MAP_FAILED;
  size_t size = 0;
  int fd = -1;
  uint32_t index = 0;
  uint32_t width = 0;
  uint32_t height = 0;
  bool active = false;
  bool released = true;
  uint64_t generation = 0;
};

struct PendingFrame {
  std::vector<uint8_t> pixels;
  uint32_t width = 0;
  uint32_t height = 0;
  uint64_t generation = 0;
};

class LayerShellController : public Napi::ObjectWrap<LayerShellController> {
 public:
  static Napi::Function Define(Napi::Env env) {
    return DefineClass(env, "LayerShellController", {
      InstanceMethod("initialize", &LayerShellController::InitializeMethod),
      InstanceMethod("submitFrame", &LayerShellController::SubmitFrame),
      InstanceMethod("getState", &LayerShellController::GetState),
      InstanceMethod("close", &LayerShellController::CloseMethod)
    });
  }

  LayerShellController(const Napi::CallbackInfo& info)
      : Napi::ObjectWrap<LayerShellController>(info) {
    const Napi::Object options = info[0].As<Napi::Object>();
    if (options.Has("output") && !options.Get("output").IsUndefined()) {
      requestedOutput_ = options.Get("output").As<Napi::String>().Utf8Value();
    }
    namespace_ = options.Has("namespace")
        ? options.Get("namespace").As<Napi::String>().Utf8Value()
        : "covas-electron-overlay";
    if (options.Has("initializationTimeoutMs")) {
      initializationTimeoutMs_ = options.Get("initializationTimeoutMs").As<Napi::Number>().Uint32Value();
    }
  }

  ~LayerShellController() override { Close(); }

 private:
  class InitializeWorker final : public Napi::AsyncWorker {
   public:
    InitializeWorker(LayerShellController* owner, Napi::Env env)
        : Napi::AsyncWorker(env), owner_(owner), deferred_(Napi::Promise::Deferred::New(env)) {}

    Napi::Promise Promise() const { return deferred_.Promise(); }

    void Execute() override {
      try {
        owner_->Initialize();
      } catch (const std::exception& error) {
        owner_->Close();
        SetError(error.what());
      }
    }

    void OnOK() override {
      owner_->initializing_ = false;
      deferred_.Resolve(Env().Undefined());
      owner_->Unref();
    }

    void OnError(const Napi::Error& error) override {
      owner_->initializing_ = false;
      deferred_.Reject(error.Value());
      owner_->Unref();
    }

   private:
    LayerShellController* owner_;
    Napi::Promise::Deferred deferred_;
  };

  Napi::Value InitializeMethod(const Napi::CallbackInfo& info) {
    if (closed_) {
      Napi::Error::New(info.Env(), "Cannot initialize a closed layer-shell controller.")
          .ThrowAsJavaScriptException();
      return info.Env().Undefined();
    }
    if (initializationStarted_.exchange(true)) {
      Napi::Error::New(info.Env(), "Layer-shell initialization has already started.")
          .ThrowAsJavaScriptException();
      return info.Env().Undefined();
    }
    Ref();
    initializing_ = true;
    auto* worker = new InitializeWorker(this, info.Env());
    const Napi::Promise promise = worker->Promise();
    worker->Queue();
    return promise;
  }

  void Initialize() {
    initializationDeadline_ = std::chrono::steady_clock::now()
        + std::chrono::milliseconds(initializationTimeoutMs_);
    display_ = ConnectDisplay();
    if (!display_) {
      throw std::runtime_error("Could not connect to WAYLAND_DISPLAY.");
    }

    registry_ = wl_display_get_registry(display_);
    static const wl_registry_listener registryListener = {
      RegistryGlobal,
      RegistryGlobalRemove
    };
    wl_registry_add_listener(registry_, &registryListener, this);
    Roundtrip("discovering Wayland globals");
    Roundtrip("reading Wayland output names");

    if (!compositor_) throw std::runtime_error("Wayland compositor does not expose wl_compositor.");
    if (!shm_) throw std::runtime_error("Wayland compositor does not expose wl_shm.");
    if (!layerShell_) {
      throw std::runtime_error("Wayland compositor does not expose zwlr_layer_shell_v1.");
    }

    wl_output* output = nullptr;
    if (!requestedOutput_.empty()) {
      const auto match = std::find_if(outputs_.begin(), outputs_.end(), [this](const Output& candidate) {
        return candidate.name == requestedOutput_;
      });
      if (match == outputs_.end()) {
        throw std::runtime_error("Wayland output not found: " + requestedOutput_);
      }
      output = match->proxy;
      selectedOutput_ = match->name;
      selectedOutputInfo_ = &*match;
    }

    surface_ = wl_compositor_create_surface(compositor_);
    if (!surface_) throw std::runtime_error("Could not create the Wayland surface.");

    wl_region* emptyRegion = wl_compositor_create_region(compositor_);
    wl_surface_set_input_region(surface_, emptyRegion);
    wl_region_destroy(emptyRegion);

    layerSurface_ = zwlr_layer_shell_v1_get_layer_surface(
        layerShell_, surface_, output, ZWLR_LAYER_SHELL_V1_LAYER_OVERLAY,
        namespace_.c_str());
    if (!layerSurface_) throw std::runtime_error("Could not create the layer-shell surface.");

    static const zwlr_layer_surface_v1_listener layerSurfaceListener = {
      LayerConfigure,
      LayerClosed
    };
    zwlr_layer_surface_v1_add_listener(layerSurface_, &layerSurfaceListener, this);
    zwlr_layer_surface_v1_set_size(layerSurface_, 0, 0);
    zwlr_layer_surface_v1_set_anchor(layerSurface_, kAllAnchors);
    zwlr_layer_surface_v1_set_exclusive_zone(layerSurface_, -1);
    zwlr_layer_surface_v1_set_keyboard_interactivity(
        layerSurface_, ZWLR_LAYER_SURFACE_V1_KEYBOARD_INTERACTIVITY_NONE);
    wl_surface_commit(surface_);

    Roundtrip("waiting for the initial layer-shell configure event");
    if (!configured_) {
      throw std::runtime_error("The compositor did not configure the layer-shell surface.");
    }
    if (!GetError().empty()) throw std::runtime_error(GetError());
    wl_display_flush(display_);
    wakeFd_ = eventfd(0, EFD_CLOEXEC | EFD_NONBLOCK);
    if (wakeFd_ < 0) throw std::runtime_error("Could not create the layer-shell frame wake descriptor.");
    dispatchThread_ = std::thread([this] { DispatchLoop(); });
  }

  void Roundtrip(const char* operation) {
    bool done = false;
    wl_callback* callback = wl_display_sync(display_);
    static const wl_callback_listener listener = { SyncDone };
    wl_callback_add_listener(callback, &listener, &done);

    while (!done) {
      if (wl_display_dispatch_pending(display_) < 0) break;
      if (done) break;
      if (wl_display_prepare_read(display_) != 0) continue;
      if (wl_display_flush(display_) < 0 && errno != EAGAIN) {
        wl_display_cancel_read(display_);
        break;
      }

      const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(
          initializationDeadline_ - std::chrono::steady_clock::now()).count();
      if (remaining <= 0) {
        wl_display_cancel_read(display_);
        wl_callback_destroy(callback);
        throw std::runtime_error(std::string("Timed out while ") + operation + ".");
      }
      pollfd descriptor = { wl_display_get_fd(display_), POLLIN, 0 };
      const int ready = poll(&descriptor, 1, static_cast<int>(remaining));
      if (ready > 0 && (descriptor.revents & POLLIN)) {
        if (wl_display_read_events(display_) < 0) break;
      } else {
        wl_display_cancel_read(display_);
        if (ready == 0) {
          wl_callback_destroy(callback);
          throw std::runtime_error(std::string("Timed out while ") + operation + ".");
        }
        if (ready < 0 && errno == EINTR) continue;
        break;
      }
    }
    wl_callback_destroy(callback);
    if (!done) {
      throw std::runtime_error(std::string("Wayland connection failed while ") + operation + ".");
    }
  }

  wl_display* ConnectDisplay() {
    if (std::getenv("WAYLAND_SOCKET")) return wl_display_connect(nullptr);

    const char* displayName = std::getenv("WAYLAND_DISPLAY");
    if (!displayName || !*displayName) displayName = "wayland-0";
    std::string path;
    if (displayName[0] == '/') {
      path = displayName;
    } else {
      const char* runtimeDir = std::getenv("XDG_RUNTIME_DIR");
      if (!runtimeDir || !*runtimeDir) return nullptr;
      path = std::string(runtimeDir) + "/" + displayName;
    }
    sockaddr_un address = {};
    if (path.size() >= sizeof(address.sun_path)) {
      throw std::runtime_error("WAYLAND_DISPLAY socket path is too long.");
    }

    const int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
    if (fd < 0) return nullptr;
    address.sun_family = AF_UNIX;
    std::memcpy(address.sun_path, path.c_str(), path.size() + 1);
    if (connect(fd, reinterpret_cast<sockaddr*>(&address), sizeof(address)) < 0
        && errno != EINPROGRESS) {
      close(fd);
      return nullptr;
    }

    pollfd descriptor = { fd, POLLOUT, 0 };
    const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(
        initializationDeadline_ - std::chrono::steady_clock::now()).count();
    const int ready = remaining > 0 ? poll(&descriptor, 1, static_cast<int>(remaining)) : 0;
    int socketError = 0;
    socklen_t errorSize = sizeof(socketError);
    if (ready <= 0 || !(descriptor.revents & POLLOUT)
        || getsockopt(fd, SOL_SOCKET, SO_ERROR, &socketError, &errorSize) < 0
        || socketError != 0) {
      close(fd);
      if (ready == 0) throw std::runtime_error("Timed out while connecting to WAYLAND_DISPLAY.");
      return nullptr;
    }
    return wl_display_connect_to_fd(fd);
  }

  std::pair<ShmBuffer*, ShmBuffer*> CreateBuffers(uint32_t width, uint32_t height) {
    ResolveConfiguredSize(width, height);
    ClearError();
    const uint64_t stride64 = static_cast<uint64_t>(width) * 4;
    const uint64_t size64 = stride64 * height;
    if (stride64 > INT32_MAX || size64 > INT32_MAX || size64 > SIZE_MAX) {
      SetError("The configured layer surface is too large for a wl_shm buffer.");
      return { nullptr, nullptr };
    }

    const int32_t stride = static_cast<int32_t>(stride64);
    static const wl_buffer_listener bufferListener = { BufferRelease };
    const uint64_t generation = nextGeneration_++;
    std::vector<std::unique_ptr<ShmBuffer>> newBuffers;
    const auto cleanupNewBuffers = [this, &newBuffers] {
      for (const std::unique_ptr<ShmBuffer>& buffer : newBuffers) DestroyBuffer(*buffer);
    };
    ShmBuffer* created[2] = { nullptr, nullptr };
    for (uint32_t index = 0; index < 2; index += 1) {
      auto storage = std::make_unique<ShmBuffer>();
      ShmBuffer& buffer = *storage;
      buffer.owner = this;
      buffer.index = index;
      buffer.width = width;
      buffer.height = height;
      buffer.active = true;
      buffer.generation = generation;
      buffer.size = static_cast<size_t>(size64);
      buffer.fd = memfd_create("electron-overlay-layer-shell", MFD_CLOEXEC);
      if (buffer.fd < 0 || ftruncate(buffer.fd, static_cast<off_t>(buffer.size)) < 0) {
        SetError(std::string("Could not allocate a Wayland shared-memory file: ") + std::strerror(errno));
        DestroyBuffer(buffer);
        cleanupNewBuffers();
        return { nullptr, nullptr };
      }
      buffer.data = mmap(nullptr, buffer.size, PROT_READ | PROT_WRITE, MAP_SHARED, buffer.fd, 0);
      if (buffer.data == MAP_FAILED) {
        SetError(std::string("Could not map a Wayland shared-memory buffer: ") + std::strerror(errno));
        DestroyBuffer(buffer);
        cleanupNewBuffers();
        return { nullptr, nullptr };
      }
      wl_shm_pool* pool = wl_shm_create_pool(shm_, buffer.fd, static_cast<int32_t>(buffer.size));
      if (!pool) {
        SetError("Could not create a Wayland shared-memory pool.");
        DestroyBuffer(buffer);
        cleanupNewBuffers();
        return { nullptr, nullptr };
      }
      buffer.proxy = wl_shm_pool_create_buffer(
          pool, 0, static_cast<int32_t>(width), static_cast<int32_t>(height),
          stride, WL_SHM_FORMAT_ARGB8888);
      wl_shm_pool_destroy(pool);
      if (!buffer.proxy) {
        SetError("Could not create a Wayland shared-memory buffer.");
        DestroyBuffer(buffer);
        cleanupNewBuffers();
        return { nullptr, nullptr };
      }
      wl_buffer_add_listener(buffer.proxy, &bufferListener, &buffer);
      std::memset(buffer.data, 0, buffer.size);
      created[index] = &buffer;
      newBuffers.push_back(std::move(storage));
    }

    for (const std::unique_ptr<ShmBuffer>& buffer : buffers_) buffer->active = false;
    CollectReleasedBuffers();
    for (std::unique_ptr<ShmBuffer>& buffer : newBuffers) buffers_.push_back(std::move(buffer));
    width_ = width;
    height_ = height;
    {
      std::lock_guard<std::mutex> lock(frameMutex_);
      configuredGeneration_ = generation;
      configuredWidth_ = width;
      configuredHeight_ = height;
      acceptingFrames_ = true;
      if (pendingFrame_) {
        pendingFrame_.reset();
        droppedFrameCount_ += 1;
      }
    }
    return { created[0], created[1] };
  }

  void DestroyBuffer(ShmBuffer& buffer) {
    if (buffer.proxy) wl_buffer_destroy(buffer.proxy);
    if (buffer.data != MAP_FAILED) munmap(buffer.data, buffer.size);
    if (buffer.fd >= 0) close(buffer.fd);
    buffer.proxy = nullptr;
    buffer.data = MAP_FAILED;
    buffer.fd = -1;
  }

  void AttachFrame(ShmBuffer* buffer, bool requestNextFrame) {
    if (!buffer || !buffer->proxy || !surface_) return;
    buffer->released = false;
    wl_surface_attach(surface_, buffer->proxy, 0, 0);
    wl_surface_damage(surface_, 0, 0, static_cast<int32_t>(buffer->width),
                      static_cast<int32_t>(buffer->height));
    if (requestNextFrame) {
      frameCallback_ = wl_surface_frame(surface_);
      static const wl_callback_listener callbackListener = { FrameDone };
      wl_callback_add_listener(frameCallback_, &callbackListener, this);
    }
    wl_surface_commit(surface_);
    frameCount_ += 1;
    mapped_ = true;
  }

  void DispatchLoop() {
    const int displayFd = wl_display_get_fd(display_);
    while (!stop_) {
      if (wl_display_dispatch_pending(display_) < 0) {
        HandleDisplayFailure("The Wayland compositor disconnected.");
        break;
      }
      PumpFrame();
      bool needsWrite = false;
      if (wl_display_flush(display_) < 0) {
        if (errno == EAGAIN) needsWrite = true;
        else {
          HandleDisplayFailure(std::string("Could not flush the Wayland connection: ") + std::strerror(errno));
          break;
        }
      }
      pollfd descriptors[2] = {
        { displayFd, static_cast<short>(POLLIN | (needsWrite ? POLLOUT : 0)), 0 },
        { wakeFd_, POLLIN, 0 }
      };
      const int ready = poll(descriptors, 2, -1);
      if (ready < 0) {
        if (errno == EINTR) continue;
        HandleDisplayFailure(std::string("Could not poll the Wayland connection: ") + std::strerror(errno));
        break;
      }
      if (descriptors[0].revents & POLLIN) {
        if (wl_display_dispatch(display_) < 0 && !stop_) {
          HandleDisplayFailure("The Wayland compositor disconnected.");
          break;
        }
      } else if (descriptors[0].revents & (POLLERR | POLLHUP | POLLNVAL)) {
        HandleDisplayFailure("The Wayland compositor disconnected.");
        break;
      }
      if (descriptors[0].revents & POLLOUT) {
        if (wl_display_flush(display_) < 0 && errno != EAGAIN) {
          HandleDisplayFailure(std::string("Could not flush the Wayland connection: ") + std::strerror(errno));
          break;
        }
      }
      if (descriptors[1].revents & (POLLERR | POLLHUP | POLLNVAL)) {
        HandleDisplayFailure("The layer-shell frame wake descriptor failed.");
        break;
      }
      if (descriptors[1].revents & POLLIN) DrainWake();
    }
  }

  void PumpFrame() {
    if (stop_ || compositorClosed_ || !configured_ || frameCallback_) return;
    std::unique_ptr<PendingFrame> frame;
    ShmBuffer* target = nullptr;
    {
      std::lock_guard<std::mutex> lock(frameMutex_);
      if (!pendingFrame_) return;
      if (pendingFrame_->generation != configuredGeneration_
          || pendingFrame_->width != configuredWidth_
          || pendingFrame_->height != configuredHeight_) {
        pendingFrame_.reset();
        droppedFrameCount_ += 1;
        return;
      }
      const auto available = std::find_if(buffers_.begin(), buffers_.end(), [this](const auto& buffer) {
        return buffer->active && buffer->released
            && buffer->generation == configuredGeneration_;
      });
      if (available == buffers_.end()) return;
      target = available->get();
      frame = std::move(pendingFrame_);
    }
    std::memcpy(target->data, frame->pixels.data(), frame->pixels.size());
    uint32_t checksum = 2166136261u;
    for (const uint8_t byte : frame->pixels) checksum = (checksum ^ byte) * 16777619u;
    AttachFrame(target, true);
    lastFrameChecksum_ = checksum;
  }

  void SignalWake() {
    if (wakeFd_ < 0) return;
    const uint64_t value = 1;
    while (write(wakeFd_, &value, sizeof(value)) < 0 && errno == EINTR) {}
  }

  void DrainWake() {
    uint64_t value;
    while (read(wakeFd_, &value, sizeof(value)) < 0 && errno == EINTR) {}
  }

  void HandleDisplayFailure(std::string error) {
    SetError(std::move(error));
    compositorClosed_ = true;
    mapped_ = false;
    std::lock_guard<std::mutex> lock(frameMutex_);
    acceptingFrames_ = false;
    pendingFrame_.reset();
  }

  void ResolveConfiguredSize(uint32_t& width, uint32_t& height) const {
    const Output* fallback = selectedOutputInfo_;
    if (width == 0) {
      width = fallback && fallback->width
          ? fallback->width / static_cast<uint32_t>(std::max(fallback->scale, 1))
          : width_.load();
    }
    if (height == 0) {
      height = fallback && fallback->height
          ? fallback->height / static_cast<uint32_t>(std::max(fallback->scale, 1))
          : height_.load();
    }
    if (width == 0) width = 1;
    if (height == 0) height = 1;
  }

  void CollectReleasedBuffers() {
    const auto removable = [](const std::unique_ptr<ShmBuffer>& buffer) {
      return !buffer->active && buffer->released;
    };
    for (const std::unique_ptr<ShmBuffer>& buffer : buffers_) {
      if (!removable(buffer)) continue;
      DestroyBuffer(*buffer);
    }
    buffers_.erase(std::remove_if(buffers_.begin(), buffers_.end(), removable), buffers_.end());
  }

  void Close() {
    if (closed_.exchange(true)) return;
    {
      std::lock_guard<std::mutex> lock(frameMutex_);
      acceptingFrames_ = false;
      pendingFrame_.reset();
      stop_ = true;
      SignalWake();
    }
    mapped_ = false;
    if (dispatchThread_.joinable()) dispatchThread_.join();
    if (wakeFd_ >= 0) close(wakeFd_);
    wakeFd_ = -1;
    mapped_ = false;

    if (frameCallback_) wl_callback_destroy(frameCallback_);
    frameCallback_ = nullptr;
    for (const std::unique_ptr<ShmBuffer>& buffer : buffers_) {
      DestroyBuffer(*buffer);
    }
    if (layerSurface_) zwlr_layer_surface_v1_destroy(layerSurface_);
    if (surface_) wl_surface_destroy(surface_);
    for (Output& output : outputs_) {
      if (output.proxy) wl_output_destroy(output.proxy);
    }
    if (layerShell_) {
      if (layerShellVersion_ >= 3) zwlr_layer_shell_v1_destroy(layerShell_);
      else wl_proxy_destroy(reinterpret_cast<wl_proxy*>(layerShell_));
    }
    if (shm_) wl_shm_destroy(shm_);
    if (compositor_) wl_compositor_destroy(compositor_);
    if (registry_) wl_registry_destroy(registry_);
    if (display_) wl_display_disconnect(display_);
    display_ = nullptr;
  }

  Napi::Value SubmitFrame(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() != 3 || !info[0].IsBuffer() || !info[1].IsNumber() || !info[2].IsNumber()) {
      Napi::TypeError::New(env, "submitFrame expects a Buffer, width, and height.")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    const double widthValue = info[1].As<Napi::Number>().DoubleValue();
    const double heightValue = info[2].As<Napi::Number>().DoubleValue();
    if (!std::isfinite(widthValue) || !std::isfinite(heightValue)
        || widthValue <= 0 || heightValue <= 0
        || std::floor(widthValue) != widthValue || std::floor(heightValue) != heightValue
        || widthValue > UINT32_MAX || heightValue > UINT32_MAX) {
      Napi::RangeError::New(env, "Frame width and height must be positive 32-bit integers.")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    const uint32_t width = static_cast<uint32_t>(widthValue);
    const uint32_t height = static_cast<uint32_t>(heightValue);
    if (width > static_cast<uint64_t>(INT32_MAX) / 4
        || height > static_cast<uint64_t>(INT32_MAX) / (static_cast<uint64_t>(width) * 4)) {
      Napi::RangeError::New(env, "Frame dimensions exceed the wl_shm buffer size limit.")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    const uint64_t expectedSize = static_cast<uint64_t>(width) * height * 4;
    const Napi::Buffer<uint8_t> source = info[0].As<Napi::Buffer<uint8_t>>();
    if (expectedSize > SIZE_MAX || source.Length() != expectedSize) {
      Napi::RangeError::New(env, "Frame Buffer length must equal width * height * 4.")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    uint64_t generation = 0;
    {
      std::lock_guard<std::mutex> lock(frameMutex_);
      if (!acceptingFrames_ || closed_ || compositorClosed_) return Napi::Boolean::New(env, false);
      if (width != configuredWidth_ || height != configuredHeight_) {
        droppedFrameCount_ += 1;
        return Napi::Boolean::New(env, false);
      }
      generation = configuredGeneration_;
    }
    auto frame = std::make_unique<PendingFrame>();
    frame->pixels.assign(source.Data(), source.Data() + source.Length());
    frame->width = width;
    frame->height = height;
    frame->generation = generation;
    {
      std::lock_guard<std::mutex> lock(frameMutex_);
      if (!acceptingFrames_ || closed_ || compositorClosed_
          || width != configuredWidth_ || height != configuredHeight_
          || generation != configuredGeneration_) {
        droppedFrameCount_ += 1;
        return Napi::Boolean::New(env, false);
      }
      if (pendingFrame_) droppedFrameCount_ += 1;
      pendingFrame_ = std::move(frame);
      submittedFrameCount_ += 1;
      SignalWake();
    }
    return Napi::Boolean::New(env, true);
  }

  Napi::Value GetState(const Napi::CallbackInfo& info) {
    if (initializing_) {
      Napi::Error::New(info.Env(), "Cannot read layer-shell state while it is initializing.")
          .ThrowAsJavaScriptException();
      return info.Env().Undefined();
    }
    Napi::Object state = Napi::Object::New(info.Env());
    state.Set("configured", configured_.load());
    state.Set("mapped", mapped_.load());
    state.Set("closed", closed_.load());
    state.Set("compositorClosed", compositorClosed_.load());
    state.Set("width", width_.load());
    state.Set("height", height_.load());
    state.Set("frameCount", frameCount_.load());
    state.Set("bufferReleaseCount", bufferReleaseCount_.load());
    state.Set("submittedFrameCount", submittedFrameCount_.load());
    state.Set("droppedFrameCount", droppedFrameCount_.load());
    state.Set("lastFrameChecksum", lastFrameChecksum_.load());
    if (selectedOutput_.empty()) state.Set("output", info.Env().Undefined());
    else state.Set("output", selectedOutput_);
    const std::string error = GetError();
    if (error.empty()) state.Set("error", info.Env().Undefined());
    else state.Set("error", error);
    return state;
  }

  void CloseMethod(const Napi::CallbackInfo& info) {
    if (initializing_) {
      Napi::Error::New(info.Env(), "Cannot close a layer-shell controller while it is initializing.")
          .ThrowAsJavaScriptException();
      return;
    }
    Close();
  }

  void SetError(std::string error) {
    std::lock_guard<std::mutex> lock(errorMutex_);
    error_ = std::move(error);
  }

  std::string GetError() {
    std::lock_guard<std::mutex> lock(errorMutex_);
    return error_;
  }

  void ClearError() {
    std::lock_guard<std::mutex> lock(errorMutex_);
    error_.clear();
  }

  static void SyncDone(void* data, wl_callback*, uint32_t) {
    *static_cast<bool*>(data) = true;
  }

  static void RegistryGlobal(void* data, wl_registry* registry, uint32_t name,
                             const char* interface, uint32_t version) {
    auto* self = static_cast<LayerShellController*>(data);
    if (std::strcmp(interface, wl_compositor_interface.name) == 0) {
      self->compositor_ = static_cast<wl_compositor*>(wl_registry_bind(
          registry, name, &wl_compositor_interface, std::min(version, 4u)));
    } else if (std::strcmp(interface, wl_shm_interface.name) == 0) {
      self->shm_ = static_cast<wl_shm*>(wl_registry_bind(
          registry, name, &wl_shm_interface, 1));
    } else if (std::strcmp(interface, zwlr_layer_shell_v1_interface.name) == 0) {
      self->layerShellVersion_ = std::min(version, 4u);
      self->layerShell_ = static_cast<zwlr_layer_shell_v1*>(wl_registry_bind(
          registry, name, &zwlr_layer_shell_v1_interface, self->layerShellVersion_));
    } else if (std::strcmp(interface, wl_output_interface.name) == 0) {
      Output output;
      output.globalName = name;
      output.proxy = static_cast<wl_output*>(wl_registry_bind(
          registry, name, &wl_output_interface, std::min(version, 4u)));
      self->outputs_.push_back(std::move(output));
      static const wl_output_listener outputListener = {
        OutputGeometry,
        OutputMode,
        OutputDone,
        OutputScale,
        OutputName,
        OutputDescription
      };
      wl_output_add_listener(self->outputs_.back().proxy, &outputListener,
                             &self->outputs_.back());
    }
  }

  static void RegistryGlobalRemove(void*, wl_registry*, uint32_t) {}
  static void OutputGeometry(void*, wl_output*, int32_t, int32_t, int32_t,
                             int32_t, int32_t, const char*, const char*, int32_t) {}
  static void OutputMode(void* data, wl_output*, uint32_t flags, int32_t width,
                         int32_t height, int32_t) {
    if (flags & WL_OUTPUT_MODE_CURRENT) {
      auto* output = static_cast<Output*>(data);
      output->width = static_cast<uint32_t>(std::max(width, 0));
      output->height = static_cast<uint32_t>(std::max(height, 0));
    }
  }
  static void OutputDone(void*, wl_output*) {}
  static void OutputScale(void* data, wl_output*, int32_t scale) {
    static_cast<Output*>(data)->scale = std::max(scale, 1);
  }
  static void OutputName(void* data, wl_output*, const char* name) {
    static_cast<Output*>(data)->name = name;
  }
  static void OutputDescription(void*, wl_output*, const char*) {}

  static void LayerConfigure(void* data, zwlr_layer_surface_v1* surface,
                             uint32_t serial, uint32_t width, uint32_t height) {
    auto* self = static_cast<LayerShellController*>(data);
    zwlr_layer_surface_v1_ack_configure(surface, serial);
    self->ResolveConfiguredSize(width, height);
    if (width == self->width_ && height == self->height_ && self->configured_
        && self->GetError().empty()) return;
    {
      std::lock_guard<std::mutex> lock(self->frameMutex_);
      self->acceptingFrames_ = false;
      if (self->pendingFrame_) {
        self->pendingFrame_.reset();
        self->droppedFrameCount_ += 1;
      }
    }
    if (self->frameCallback_) {
      wl_callback_destroy(self->frameCallback_);
      self->frameCallback_ = nullptr;
    }
    const auto [first, second] = self->CreateBuffers(width, height);
    if (self->GetError().empty() && first && second) {
      self->configured_ = true;
      self->AttachFrame(first, true);
    }
  }

  static void LayerClosed(void* data, zwlr_layer_surface_v1*) {
    auto* self = static_cast<LayerShellController*>(data);
    self->compositorClosed_ = true;
    self->mapped_ = false;
    std::lock_guard<std::mutex> lock(self->frameMutex_);
    self->acceptingFrames_ = false;
    self->pendingFrame_.reset();
  }

  static void FrameDone(void* data, wl_callback* callback, uint32_t) {
    auto* self = static_cast<LayerShellController*>(data);
    wl_callback_destroy(callback);
    self->frameCallback_ = nullptr;
    if (self->stop_ || self->compositorClosed_) return;
    self->PumpFrame();
  }

  static void BufferRelease(void* data, wl_buffer*) {
    auto* buffer = static_cast<ShmBuffer*>(data);
    LayerShellController* owner = buffer->owner;
    buffer->released = true;
    owner->bufferReleaseCount_ += 1;
    owner->CollectReleasedBuffers();
    owner->PumpFrame();
  }

  wl_display* display_ = nullptr;
  wl_registry* registry_ = nullptr;
  wl_compositor* compositor_ = nullptr;
  wl_shm* shm_ = nullptr;
  zwlr_layer_shell_v1* layerShell_ = nullptr;
  uint32_t layerShellVersion_ = 0;
  wl_surface* surface_ = nullptr;
  zwlr_layer_surface_v1* layerSurface_ = nullptr;
  wl_callback* frameCallback_ = nullptr;
  int wakeFd_ = -1;
  std::deque<Output> outputs_;
  Output* selectedOutputInfo_ = nullptr;
  std::vector<std::unique_ptr<ShmBuffer>> buffers_;
  uint64_t nextGeneration_ = 1;
  std::thread dispatchThread_;
  std::string requestedOutput_;
  std::string selectedOutput_;
  std::string namespace_;
  uint32_t initializationTimeoutMs_ = 5000;
  std::chrono::steady_clock::time_point initializationDeadline_;
  std::mutex errorMutex_;
  std::string error_;
  std::mutex frameMutex_;
  std::unique_ptr<PendingFrame> pendingFrame_;
  uint64_t configuredGeneration_ = 0;
  uint32_t configuredWidth_ = 0;
  uint32_t configuredHeight_ = 0;
  bool acceptingFrames_ = false;
  std::atomic<bool> stop_{false};
  std::atomic<bool> initializationStarted_{false};
  std::atomic<bool> initializing_{false};
  std::atomic<bool> configured_{false};
  std::atomic<bool> mapped_{false};
  std::atomic<bool> closed_{false};
  std::atomic<bool> compositorClosed_{false};
  std::atomic<uint32_t> width_{0};
  std::atomic<uint32_t> height_{0};
  std::atomic<uint32_t> frameCount_{0};
  std::atomic<uint32_t> bufferReleaseCount_{0};
  std::atomic<uint32_t> submittedFrameCount_{0};
  std::atomic<uint32_t> droppedFrameCount_{0};
  std::atomic<uint32_t> lastFrameChecksum_{0};
};

Napi::Value CreateLayerShellOverlay(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsObject()) {
    Napi::TypeError::New(env, "options must be an object.").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  try {
    return LayerShellController::Define(env).New({ info[0] });
  } catch (const std::exception& error) {
    Napi::Error::New(env, error.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }
}

Napi::Object Initialize(Napi::Env env, Napi::Object exports) {
  exports.Set("createLayerShellOverlay", Napi::Function::New(env, CreateLayerShellOverlay));
  return exports;
}

}  // namespace

NODE_API_MODULE(wayland_layer_shell, Initialize)
