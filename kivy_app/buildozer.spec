[app]
title = PassageiroStreamer
package.name = passageirostreamer
package.domain = org.exemplo
source.dir = .
source.include_exts = py,png,jpg,kv,atlas
version = 0.1.0
requirements = python3,kivy
orientation = portrait
fullscreen = 1
android.permissions = CAMERA,RECORD_AUDIO,INTERNET
android.api = 33
android.minapi = 24
android.archs = arm64-v8a

[buildozer]
log_level = 2
warn_on_root = 1
