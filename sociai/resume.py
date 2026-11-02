"""Turn an uploaded resume (PDF or Word .docx) into plain text.

Files are only parsed for text: never executed, rendered or served back. The type is
decided by the file's own bytes as well as its name, and Word files are checked for
zip-bomb sizes before they're opened.
"""

import io
import re
import zipfile

MAX_BYTES = 5 * 1024 * 1024
MAX_PAGES = 20            # resumes are short; this bounds the work for odd PDFs
MAX_TEXT = 30000          # characters kept on the profile
MAX_UNPACKED = 50 * 1024 * 1024

KINDS = {
    "pdf": ("application/pdf", ".pdf"),
    "docx": ("application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".docx"),
}


class ResumeError(ValueError):
    """A problem with the upload. The message is written for the user; status is the HTTP code."""

    def __init__(self, message, status=422):
        super().__init__(message)
        self.status = status


def detect(data: bytes, filename: str) -> str:
    """'pdf' or 'docx', judged by extension and content. Anything else is refused."""
    ext = filename.lower().rsplit(".", 1)[-1] if "." in filename else ""
    if ext == "pdf" and data.startswith(b"%PDF-"):
        return "pdf"
    if ext == "docx" and data.startswith(b"PK\x03\x04"):
        return "docx"
    raise ResumeError("Upload your resume as a PDF or a Word (.docx) file.", status=415)


def extract_text(data: bytes, kind: str) -> str:
    text = _pdf_text(data) if kind == "pdf" else _docx_text(data)
    text = _tidy(text)
    if not text:
        raise ResumeError("We couldn't find any text in that file. If it's a scanned PDF, "
                          "paste your resume into the text box instead.")
    return text[:MAX_TEXT]


def _pdf_text(data):
    from pypdf import PdfReader
    try:
        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted and not reader.decrypt(""):
            raise ResumeError("That PDF is password-protected. Remove the password, or upload a .docx instead.")
        return "\n".join(reader.pages[i].extract_text() or "" for i in range(min(len(reader.pages), MAX_PAGES)))
    except ResumeError:
        raise
    except Exception as e:  # pypdf raises many kinds of errors on damaged files
        raise ResumeError("We couldn't read that PDF. Try exporting it again, or upload a .docx instead.") from e


def _docx_text(data):
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
        entries = {i.filename: i for i in archive.infolist()}
    except zipfile.BadZipFile as e:
        raise ResumeError("We couldn't read that Word file. Try saving it again as .docx.") from e
    if "word/document.xml" not in entries:
        raise ResumeError("That file isn't a Word .docx document.")
    if sum(i.file_size for i in entries.values()) > MAX_UNPACKED:
        raise ResumeError("That Word file is too large once unpacked.")
    import docx
    try:
        doc = docx.Document(io.BytesIO(data))
    except Exception as e:
        raise ResumeError("We couldn't read that Word file. Try saving it again as .docx.") from e
    parts = [p.text for p in doc.paragraphs]
    for table in doc.tables:
        for row in table.rows:
            cells = []
            for cell in row.cells:  # merged cells repeat; keep each once
                if cell.text not in cells:
                    cells.append(cell.text)
            parts.append(" | ".join(cells))
    return "\n".join(parts)


def _tidy(text):
    lines = [re.sub(r"[ \t ]+", " ", ln).strip() for ln in text.replace("\r", "\n").split("\n")]
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()
