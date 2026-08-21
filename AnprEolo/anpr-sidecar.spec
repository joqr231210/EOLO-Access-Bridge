# -*- mode: python ; coding: utf-8 -*-

from PyInstaller.utils.hooks import collect_data_files, collect_dynamic_libs, collect_submodules

onnxruntime_binaries = collect_dynamic_libs("onnxruntime")
onnxruntime_datas = collect_data_files("onnxruntime")
fast_plate_ocr_datas = collect_data_files("fast_plate_ocr")
ultralytics_datas = collect_data_files("ultralytics")

a = Analysis(
    ["web_config.py"],
    pathex=[],
    binaries=onnxruntime_binaries,
    datas=[
        *onnxruntime_datas,
        *fast_plate_ocr_datas,
        *ultralytics_datas,
        ("app.py", "."),
        ("bubble_config.py", "."),
        ("model.pt", "."),
        ("best.pt", "."),
        ("cct_xs_v1_global.onnx", "."),
        ("cct_xs_v1_global_plate_config.yaml", "."),
        ("config.default.json", "."),
        ("templates", "templates"),
        ("static/css", "static/css"),
        ("static/js", "static/js"),
    ],
    hiddenimports=[
        *collect_submodules("cv2"),
        *collect_submodules("fast_plate_ocr"),
        *collect_submodules("onnxruntime"),
        *collect_submodules("ultralytics"),
        "app",
        "bubble_config",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="anpr-eolo",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="anpr-eolo",
)
