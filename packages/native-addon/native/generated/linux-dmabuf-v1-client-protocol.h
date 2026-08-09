/* Generated-equivalent client bindings for linux-dmabuf-unstable-v1 v3. */
#ifndef LINUX_DMABUF_V1_CLIENT_PROTOCOL_H
#define LINUX_DMABUF_V1_CLIENT_PROTOCOL_H

#include <stdint.h>
#include <wayland-client-core.h>
#include <wayland-client-protocol.h>

#ifdef __cplusplus
extern "C" {
#endif

struct zwp_linux_dmabuf_v1;
struct zwp_linux_buffer_params_v1;

extern const struct wl_interface zwp_linux_dmabuf_v1_interface;
extern const struct wl_interface zwp_linux_buffer_params_v1_interface;

struct zwp_linux_dmabuf_v1_listener {
  void (*format)(void *data, struct zwp_linux_dmabuf_v1 *object,
                 uint32_t format);
  void (*modifier)(void *data, struct zwp_linux_dmabuf_v1 *object,
                   uint32_t format, uint32_t modifier_hi,
                   uint32_t modifier_lo);
};

struct zwp_linux_buffer_params_v1_listener {
  void (*created)(void *data, struct zwp_linux_buffer_params_v1 *object,
                  struct wl_buffer *buffer);
  void (*failed)(void *data, struct zwp_linux_buffer_params_v1 *object);
};

static inline int zwp_linux_dmabuf_v1_add_listener(
    struct zwp_linux_dmabuf_v1 *object,
    const struct zwp_linux_dmabuf_v1_listener *listener, void *data) {
  return wl_proxy_add_listener((struct wl_proxy *) object,
                               (void (**)(void)) listener, data);
}

static inline struct zwp_linux_buffer_params_v1 *
zwp_linux_dmabuf_v1_create_params(struct zwp_linux_dmabuf_v1 *object) {
  return (struct zwp_linux_buffer_params_v1 *) wl_proxy_marshal_flags(
      (struct wl_proxy *) object, 1, &zwp_linux_buffer_params_v1_interface,
      wl_proxy_get_version((struct wl_proxy *) object), 0, NULL);
}

static inline void zwp_linux_dmabuf_v1_destroy(
    struct zwp_linux_dmabuf_v1 *object) {
  wl_proxy_marshal_flags((struct wl_proxy *) object, 0, NULL,
                         wl_proxy_get_version((struct wl_proxy *) object),
                         WL_MARSHAL_FLAG_DESTROY);
}

static inline int zwp_linux_buffer_params_v1_add_listener(
    struct zwp_linux_buffer_params_v1 *object,
    const struct zwp_linux_buffer_params_v1_listener *listener, void *data) {
  return wl_proxy_add_listener((struct wl_proxy *) object,
                               (void (**)(void)) listener, data);
}

static inline void zwp_linux_buffer_params_v1_add(
    struct zwp_linux_buffer_params_v1 *object, int32_t fd,
    uint32_t plane_idx, uint32_t offset, uint32_t stride,
    uint32_t modifier_hi, uint32_t modifier_lo) {
  wl_proxy_marshal_flags((struct wl_proxy *) object, 1, NULL,
                         wl_proxy_get_version((struct wl_proxy *) object), 0,
                         fd, plane_idx, offset, stride, modifier_hi,
                         modifier_lo);
}

static inline void zwp_linux_buffer_params_v1_create(
    struct zwp_linux_buffer_params_v1 *object, int32_t width,
    int32_t height, uint32_t format, uint32_t flags) {
  wl_proxy_marshal_flags((struct wl_proxy *) object, 2, NULL,
                         wl_proxy_get_version((struct wl_proxy *) object), 0,
                         width, height, format, flags);
}

static inline struct wl_buffer *zwp_linux_buffer_params_v1_create_immed(
    struct zwp_linux_buffer_params_v1 *object, int32_t width,
    int32_t height, uint32_t format, uint32_t flags) {
  return (struct wl_buffer *) wl_proxy_marshal_flags(
      (struct wl_proxy *) object, 3, &wl_buffer_interface,
      wl_proxy_get_version((struct wl_proxy *) object), 0, NULL,
      width, height, format, flags);
}

static inline void zwp_linux_buffer_params_v1_destroy(
    struct zwp_linux_buffer_params_v1 *object) {
  wl_proxy_marshal_flags((struct wl_proxy *) object, 0, NULL,
                         wl_proxy_get_version((struct wl_proxy *) object),
                         WL_MARSHAL_FLAG_DESTROY);
}

#ifdef __cplusplus
}
#endif

#endif
