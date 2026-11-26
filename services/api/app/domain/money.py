import hashlib
import json
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Any

# ISO 4217 currency minor-unit scales (TND/BHD/KWD/OMR use 3 decimals; JPY uses 0)
SUPPORTED_CURRENCIES: dict[str, int] = {
    "TND": 3,
    "USD": 2,
    "EUR": 2,
    "GBP": 2,
    "MAD": 2,
    "DZD": 2,
    "EGP": 2,
    "SAR": 2,
    "AED": 2,
    "QAR": 2,
    "KWD": 3,
    "BHD": 3,
    "OMR": 3,
    "CAD": 2,
    "AUD": 2,
    "CHF": 2,
    "CNY": 2,
    "JPY": 0,
}


def parse_decimal(value: str | int | Decimal, field_name: str = "amount") -> Decimal:
    if isinstance(value, float):
        raise ValueError(f"{field_name} must not use binary float; pass Decimal or string")
    cleaned = str(value).strip().replace(" ", "").replace(",", "")
    try:
        dec = Decimal(cleaned)
    except (InvalidOperation, ValueError) as exc:
        raise ValueError(f"Invalid decimal for {field_name}: {value!r}") from exc
    if not dec.is_finite():
        raise ValueError(f"{field_name} must be finite")
    return dec


def quantize_money(amount: Decimal, currency: str) -> Decimal:
    code = currency.upper()
    scale = SUPPORTED_CURRENCIES.get(code, 2)
    quantum = Decimal(1) if scale == 0 else Decimal(10) ** (-scale)
    return amount.quantize(quantum, rounding=ROUND_HALF_UP)


def format_money_str(amount: Decimal | None, currency: str) -> str | None:
    if amount is None:
        return None
    return str(quantize_money(amount, currency))


# Approximate USD reference rates used strictly for approver authority-limit normalization
# (never used to convert or alter commercial quotation / PO currency amounts).
APPROX_USD_PER_UNIT: dict[str, Decimal] = {
    "USD": Decimal("1.00"),
    "EUR": Decimal("1.09"),
    "GBP": Decimal("1.27"),
    "CHF": Decimal("1.13"),
    "CAD": Decimal("0.73"),
    "AUD": Decimal("0.66"),
    "TND": Decimal("0.32"),
    "MAD": Decimal("0.10"),
    "DZD": Decimal("0.0075"),
    "EGP": Decimal("0.021"),
    "SAR": Decimal("0.2667"),
    "AED": Decimal("0.2723"),
    "QAR": Decimal("0.2747"),
    "KWD": Decimal("3.25"),
    "BHD": Decimal("2.65"),
    "OMR": Decimal("2.60"),
    "CNY": Decimal("0.14"),
    "JPY": Decimal("0.0067"),
}


def to_usd_equivalent_for_limit(amount: Decimal, currency: str) -> Decimal:
    """Normalizes a non-USD approval packet amount to approximate USD solely for authority limit checks."""
    rate = APPROX_USD_PER_UNIT.get(currency.upper(), Decimal("1.00"))
    return (amount * rate).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def canonical_payload_hash(payload: dict[str, Any]) -> str:
    """Deterministic SHA-256 hash of a canonical commercial payload."""
    normalized = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return "sha256:" + hashlib.sha256(normalized.encode("utf-8")).hexdigest()
