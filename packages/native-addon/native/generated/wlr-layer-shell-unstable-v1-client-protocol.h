/* Generated-equivalent client bindings for the vendored layer-shell v1 XML. */
#ifndef WLR_LAYER_SHELL_UNSTABLE_V1_CLIENT_PROTOCOL_H
#define WLR_LAYER_SHELL_UNSTABLE_V1_CLIENT_PROTOCOL_H

#include <stdint.h>
#include <wayland-client-core.h>
#include <wayland-client-protocol.h>

#ifdef __cplusplus
extern "C" {
#endif

struct zwlr_layer_shell_v1;
struct zwlr_layer_surface_v1;

extern const struct wl_interface zwlr_layer_shell_v1_interface;
extern const struct wl_interface zwlr_layer_surface_v1_interface;

enum zwlr_layer_shell_v1_layer {
  ZWLR_LAYER_SHELL_V1_LAYER_BACKGROUND = 0,
  ZWLR_LAYER_SHELL_V1_LAYER_BOTTOM = 1,
  ZWLR_LAYER_SHELL_V1_LAYER_TOP = 2,
  ZWLR_LAYER_SHELL_V1_LAYER_OVERLAY = 3
};

enum zwlr_layer_surface_v1_anchor {
  ZWLR_LAYER_SURFACE_V1_ANCHOR_TOP = 1,
  ZWLR_LAYER_SURFACE_V1_ANCHOR_BOTTOM = 2,
  ZWLR_LAYER_SURFACE_V1_ANCHOR_LEFT = 4,
  ZWLR_LAYER_SURFACE_V1_ANCHOR_RIGHT = 8
};

enum zwlr_layer_surface_v1_keyboard_interactivity {
  ZWLR_LAYER_SURFACE_V1_KEYBOARD_INTERACTIVITY_NONE = 0,
  ZWLR_LAYER_SURFACE_V1_KEYBOARD_INTERACTIVITY_EXCLUSIVE = 1,
  ZWLR_LAYER_SURFACE_V1_KEYBOARD_INTERACTIVITY_ON_DEMAND = 2
};

struct zwlr_layer_surface_v1_listener {
  void (*configure)(void *data, struct zwlr_layer_surface_v1 *surface,
                    uint32_t serial, uint32_t width, uint32_t height);
  void (*closed)(void *data, struct zwlr_layer_surface_v1 *surface);
};

static inline void zwlr_layer_shell_v1_set_user_data(
    struct zwlr_layer_shell_v1 *object, void *user_data) {
  wl_proxy_set_user_data((struct wl_proxy *) object, user_data);
}

static inline uint32_t zwlr_layer_shell_v1_get_version(
    struct zwlr_layer_shell_v1 *object) {
  return wl_proxy_get_version((struct wl_proxy *) object);
}

static inline struct zwlr_layer_surface_v1 *
zwlr_layer_shell_v1_get_layer_surface(struct zwlr_layer_shell_v1 *object,
                                      struct wl_surface *surface,
                                      struct wl_output *output,
                                      uint32_t layer,
                                      const char *namespace_name) {
  return (struct zwlr_layer_surface_v1 *) wl_proxy_marshal_flags(
      (struct wl_proxy *) object, 0, &zwlr_layer_surface_v1_interface,
      wl_proxy_get_version((struct wl_proxy *) object), 0, NULL, surface,
      output, layer, namespace_name);
}

static inline void zwlr_layer_shell_v1_destroy(
    struct zwlr_layer_shell_v1 *object) {
  wl_proxy_marshal_flags((struct wl_proxy *) object, 1, NULL,
                         wl_proxy_get_version((struct wl_proxy *) object),
                         WL_MARSHAL_FLAG_DESTROY);
}

static inline int zwlr_layer_surface_v1_add_listener(
    struct zwlr_layer_surface_v1 *object,
    const struct zwlr_layer_surface_v1_listener *listener, void *data) {
  return wl_proxy_add_listener((struct wl_proxy *) object,
                               (void (**)(void)) listener, data);
}

static inline void zwlr_layer_surface_v1_set_size(
    struct zwlr_layer_surface_v1 *object, uint32_t width, uint32_t height) {
  wl_proxy_marshal_flags((struct wl_proxy *) object, 0, NULL,
                         wl_proxy_get_version((struct wl_proxy *) object), 0,
                         width, height);
}

static inline void zwlr_layer_surface_v1_set_anchor(
    struct zwlr_layer_surface_v1 *object, uint32_t anchor) {
  wl_proxy_marshal_flags((struct wl_proxy *) object, 1, NULL,
                         wl_proxy_get_version((struct wl_proxy *) object), 0,
                         anchor);
}

static inline void zwlr_layer_surface_v1_set_exclusive_zone(
    struct zwlr_layer_surface_v1 *object, int32_t zone) {
  wl_proxy_marshal_flags((struct wl_proxy *) object, 2, NULL,
                         wl_proxy_get_version((struct wl_proxy *) object), 0,
                         zone);
}

static inline void zwlr_layer_surface_v1_set_margin(
    struct zwlr_layer_surface_v1 *object, int32_t top, int32_t right,
    int32_t bottom, int32_t left) {
  wl_proxy_marshal_flags((struct wl_proxy *) object, 3, NULL,
                         wl_proxy_get_version((struct wl_proxy *) object), 0,
                         top, right, bottom, left);
}

static inline void zwlr_layer_surface_v1_set_keyboard_interactivity(
    struct zwlr_layer_surface_v1 *object, uint32_t interactivity) {
  wl_proxy_marshal_flags((struct wl_proxy *) object, 4, NULL,
                         wl_proxy_get_version((struct wl_proxy *) object), 0,
                         interactivity);
}

static inline void zwlr_layer_surface_v1_ack_configure(
    struct zwlr_layer_surface_v1 *object, uint32_t serial) {
  wl_proxy_marshal_flags((struct wl_proxy *) object, 6, NULL,
                         wl_proxy_get_version((struct wl_proxy *) object), 0,
                         serial);
}

static inline void zwlr_layer_surface_v1_destroy(
    struct zwlr_layer_surface_v1 *object) {
  wl_proxy_marshal_flags((struct wl_proxy *) object, 7, NULL,
                         wl_proxy_get_version((struct wl_proxy *) object),
                         WL_MARSHAL_FLAG_DESTROY);
}

#ifdef __cplusplus
}
#endif

#endif
