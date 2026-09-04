---
name: document-analysis
description: Extract externally verifiable facts from local documents and media while bounding model context.
---

# Document analysis

Use the cheapest reliable path first: `pdftotext` for textual PDFs, MarkItDown for structured formats, Tesseract only for image-only material, and `ffprobe` before `ffmpeg` for media inspection.

1. Use the built-in `bash` tool and quote local paths safely.
2. Record the source file, extraction method, tool version, page or time location, and any loss or ambiguity.
3. Let the normal tool result carry extracted text. Large results are retained automatically in the existing session tool-output artifact store; cite returned artifact paths rather than copying the complete body into context.
4. Cross-check decisive facts against a second representation when practical, such as metadata plus extracted text.
5. Verify every reported fact against the source location and distinguish OCR guesses from directly decoded text.

Do not overwrite source files. Work on disposable derivatives and keep sensitive document contents out of logs not requested by the user.
