{
  "targets": [
    {
      "target_name": "x11_overlay",
      "sources": [],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "defines": [
        "NAPI_CPP_EXCEPTIONS"
      ],
      "cflags!": [
        "-fno-exceptions"
      ],
      "cflags_cc!": [
        "-fno-exceptions"
      ],
      "cflags_cc": [
        "-std=c++17"
      ],
      "xcode_settings": {
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
        "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
        "CLANG_CXX_LIBRARY": "libc++",
        "MACOSX_DEPLOYMENT_TARGET": "10.15"
      },
      "conditions": [
        [
          "OS==\"linux\"",
          {
            "sources": [
              "native/src/addon.cc"
            ],
            "libraries": [
              "-lX11",
              "-lXfixes"
            ]
          }
        ],
        [
          "OS==\"win\"",
          {
            "sources": [
              "native/src/addon_win.cc"
            ],
            "defines": [
              "NOMINMAX",
              "WIN32_LEAN_AND_MEAN"
            ],
            "msvs_settings": {
              "VCCLCompilerTool": {
                "ExceptionHandling": 1,
                "AdditionalOptions": [
                  "/std:c++17"
                ]
              }
            }
          }
        ],
        [
          "OS==\"mac\"",
          {
            "sources": [
              "native/src/addon_mac.mm"
            ],
            "libraries": [
              "-framework AppKit",
              "-framework ApplicationServices"
            ],
            "xcode_settings": {
              "CLANG_ENABLE_OBJC_ARC": "NO"
            }
          }
        ]
      ]
    }
  ]
}
