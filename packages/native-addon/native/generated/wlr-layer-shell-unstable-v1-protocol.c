/* Generated-equivalent protocol metadata for the vendored layer-shell v1 XML. */
#include <stddef.h>
#include <wayland-util.h>
#include "wlr-layer-shell-unstable-v1-client-protocol.h"

static const struct wl_interface *layer_shell_types[] = {
  &zwlr_layer_surface_v1_interface,
  &wl_surface_interface,
  &wl_output_interface,
  NULL,
  NULL
};

static const struct wl_message layer_shell_requests[] = {
  { "get_layer_surface", "no?ous", layer_shell_types },
  { "destroy", "3", NULL }
};

WL_EXPORT const struct wl_interface zwlr_layer_shell_v1_interface = {
  "zwlr_layer_shell_v1", 4, 2, layer_shell_requests, 0, NULL
};

static const struct wl_interface *layer_surface_popup_types[] = { NULL };
static const struct wl_message layer_surface_requests[] = {
  { "set_size", "uu", NULL },
  { "set_anchor", "u", NULL },
  { "set_exclusive_zone", "i", NULL },
  { "set_margin", "iiii", NULL },
  { "set_keyboard_interactivity", "u", NULL },
  { "get_popup", "o", layer_surface_popup_types },
  { "ack_configure", "u", NULL },
  { "destroy", "", NULL },
  { "set_layer", "2u", NULL }
};

static const struct wl_message layer_surface_events[] = {
  { "configure", "uuu", NULL },
  { "closed", "", NULL }
};

WL_EXPORT const struct wl_interface zwlr_layer_surface_v1_interface = {
  "zwlr_layer_surface_v1", 4, 9, layer_surface_requests, 2,
  layer_surface_events
};
