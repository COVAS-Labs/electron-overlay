/* Generated-equivalent protocol metadata for linux-dmabuf-unstable-v1 v3. */
#include <stddef.h>
#include <wayland-util.h>
#include "linux-dmabuf-v1-client-protocol.h"

static const struct wl_interface *dmabuf_create_params_types[] = {
  &zwp_linux_buffer_params_v1_interface
};

static const struct wl_message dmabuf_requests[] = {
  { "destroy", "", NULL },
  { "create_params", "n", dmabuf_create_params_types }
};

static const struct wl_message dmabuf_events[] = {
  { "format", "u", NULL },
  { "modifier", "3uuu", NULL }
};

WL_EXPORT const struct wl_interface zwp_linux_dmabuf_v1_interface = {
  "zwp_linux_dmabuf_v1", 3, 2, dmabuf_requests, 2, dmabuf_events
};

static const struct wl_interface *params_buffer_types[] = {
  &wl_buffer_interface, NULL, NULL, NULL, NULL
};

static const struct wl_message params_requests[] = {
  { "destroy", "", NULL },
  { "add", "huuuuu", NULL },
  { "create", "iiuu", NULL },
  { "create_immed", "2niiuu", params_buffer_types }
};

static const struct wl_message params_events[] = {
  { "created", "n", params_buffer_types },
  { "failed", "", NULL }
};

WL_EXPORT const struct wl_interface zwp_linux_buffer_params_v1_interface = {
  "zwp_linux_buffer_params_v1", 3, 4, params_requests, 2, params_events
};
