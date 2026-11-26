"""Error types shared by the pure core package."""

from __future__ import annotations

ERR_NOT_FOUND = "not_found"
ERR_UNAUTHORIZED = "unauthorized"
ERR_INVALID_FORMAT = "invalid_format"
ERR_INVALID_CODE = "invalid_code"
ERR_LIMIT_REACHED = "limit_reached"


class LoyaltyError(Exception):
    """Base error carrying a WebSocket error code (see ARCHITETTURA §5)."""

    code = ERR_INVALID_FORMAT

    def __init__(self, message: str, code: str | None = None) -> None:
        super().__init__(message)
        if code is not None:
            self.code = code
        self.message = message


class ValidationError(LoyaltyError):
    """Invalid payload (code `invalid_format` or `invalid_code`)."""


class NotFoundError(LoyaltyError):
    code = ERR_NOT_FOUND


class UnauthorizedError(LoyaltyError):
    code = ERR_UNAUTHORIZED


class LimitReachedError(LoyaltyError):
    """A configured limit (logo storage, store locations) would be exceeded."""

    code = ERR_LIMIT_REACHED


# §15: new WebSocket error codes.
ERR_FEATURE_DISABLED = "feature_disabled"
ERR_RECIPIENT_REFUSES = "recipient_refuses"


class FeatureDisabledError(LoyaltyError):
    """Command of a feature switched off by the administrator (§15.5)."""

    code = ERR_FEATURE_DISABLED


class RecipientRefusesError(LoyaltyError):
    """The recipient does not accept cards from other users (§15.4)."""

    code = ERR_RECIPIENT_REFUSES
