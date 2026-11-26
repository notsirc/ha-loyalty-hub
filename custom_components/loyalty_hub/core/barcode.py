"""Barcode formats (ZXing names) and alias normalization."""

from __future__ import annotations

from enum import StrEnum

from .errors import ERR_INVALID_CODE, ValidationError


class BarcodeFormat(StrEnum):
    CODE_128 = "CODE_128"
    CODE_39 = "CODE_39"
    CODE_93 = "CODE_93"
    CODABAR = "CODABAR"
    EAN_13 = "EAN_13"
    EAN_8 = "EAN_8"
    UPC_A = "UPC_A"
    UPC_E = "UPC_E"
    ITF = "ITF"
    QR_CODE = "QR_CODE"
    AZTEC = "AZTEC"
    DATA_MATRIX = "DATA_MATRIX"
    PDF_417 = "PDF_417"


DEFAULT_FORMAT = BarcodeFormat.CODE_128

# Keys are compared after lowercasing and removing "_", "-", " ".
_ALIASES: dict[str, BarcodeFormat] = {
    "code128": BarcodeFormat.CODE_128,
    "code39": BarcodeFormat.CODE_39,
    "code93": BarcodeFormat.CODE_93,
    "codabar": BarcodeFormat.CODABAR,
    "rationalizedcodabar": BarcodeFormat.CODABAR,
    "ean13": BarcodeFormat.EAN_13,
    "ean8": BarcodeFormat.EAN_8,
    "upca": BarcodeFormat.UPC_A,
    "upce": BarcodeFormat.UPC_E,
    "itf": BarcodeFormat.ITF,
    "itf14": BarcodeFormat.ITF,
    "interleaved2of5": BarcodeFormat.ITF,
    "qr": BarcodeFormat.QR_CODE,
    "qrcode": BarcodeFormat.QR_CODE,
    "aztec": BarcodeFormat.AZTEC,
    "azteccode": BarcodeFormat.AZTEC,
    "datamatrix": BarcodeFormat.DATA_MATRIX,
    "pdf417": BarcodeFormat.PDF_417,
}


def normalize_format(value: object) -> BarcodeFormat | None:
    """Return the BarcodeFormat for a name/alias, or None if unknown."""
    if isinstance(value, BarcodeFormat):
        return value
    if not isinstance(value, str):
        return None
    key = value.strip().lower().replace("_", "").replace("-", "").replace(" ", "")
    if not key:
        return None
    return _ALIASES.get(key)


def validate_code(code: str, fmt: BarcodeFormat) -> None:
    """Light validation of a code for its format; raises `invalid_code`."""

    def fail(msg: str) -> None:
        raise ValidationError(msg, ERR_INVALID_CODE)

    if fmt == BarcodeFormat.EAN_13 and not (code.isdigit() and len(code) == 13):
        fail("EAN_13 requires exactly 13 digits")
    if fmt == BarcodeFormat.EAN_8 and not (code.isdigit() and len(code) == 8):
        fail("EAN_8 requires exactly 8 digits")
    if fmt == BarcodeFormat.UPC_A and not (code.isdigit() and len(code) == 12):
        fail("UPC_A requires exactly 12 digits")
    if fmt == BarcodeFormat.UPC_E and not (code.isdigit() and 6 <= len(code) <= 8):
        fail("UPC_E requires 6 to 8 digits")
    if fmt == BarcodeFormat.ITF and not (code.isdigit() and len(code) % 2 == 0):
        fail("ITF requires an even number of digits")
