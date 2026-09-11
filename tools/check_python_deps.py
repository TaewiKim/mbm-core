import sys

print(sys.version)
for name in ["docx", "pptx", "matplotlib", "PIL", "cairosvg"]:
    try:
        __import__(name)
        print(f"{name} ok")
    except Exception as exc:
        print(f"{name} missing: {exc}")
