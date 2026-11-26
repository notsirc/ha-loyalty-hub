# Changelog

## 0.7.0 (beta) — first public release

- Card detail: a single ⋮ menu; the group actions (merge, split, tab order, rename) are at the end of it.
- Merged cards: personal group name ("Rename group"), shown on the tile and above the tabs; the tile of a group always shows its first tab.
- Lovelace card: new **Automatic** mode (default: near you, then favorites, then most used, like the panel), selector `[Auto] [All] [⭐] [📍]` under the title (remembered per user and device), editor options "Initial mode" and "Show the selector", clearer messages when the card is empty. Cards saved without `mode` now use Automatic.
- NFC: uses the device's `config_entry_id` (the old `config_entries` is deprecated in Home Assistant).
- Translations of the new texts in 17 languages.

Earlier versions (0.1–0.6) were private.
