"""Make `core` importable as a top-level package without importing Home Assistant.

`custom_components/loyalty_hub/__init__.py` imports homeassistant, so instead of
importing `custom_components.loyalty_hub.core` we put the integration directory
on sys.path and import `core` directly (core only uses relative imports).
"""

import sys
from pathlib import Path

INTEGRATION_DIR = Path(__file__).resolve().parent.parent / "custom_components" / "loyalty_hub"
if str(INTEGRATION_DIR) not in sys.path:
    sys.path.insert(0, str(INTEGRATION_DIR))
