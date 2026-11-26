# Third-party notices

## Wallet-Assistant

Loyalty Hub can import the export files of [Wallet-Assistant](https://github.com/myTselectionPublic/Wallet-Assistant).
To read its logo names the same way, `custom_components/loyalty_hub/core/wallet_assistant.py`
reuses its logo slug rule (`_SLUG_RE` and the checks in `normalize_slug()`), under this license:

```
MIT License

Copyright (c) 2026 myT

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Libraries bundled in the frontend

The built files in `custom_components/loyalty_hub/frontend/` include these libraries.
Their full license texts are in each project's repository (and in `frontend/node_modules/<name>/` after `npm ci`).

| Library | Version | License | Project |
|---|---|---|---|
| lit | 3.3.3 | BSD-3-Clause | https://github.com/lit/lit |
| bwip-js | 4.11.4 | MIT | https://github.com/metafloor/bwip-js |
| @zxing/library | 0.23.0 | Apache-2.0 | https://github.com/zxing-js/library |
| @zxing/browser | 0.2.1 | MIT | https://github.com/zxing-js/browser |
