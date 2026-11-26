import { css } from "lit";

/** Shared styles based on Home Assistant theme variables. */
export const sharedStyles = css`
  :host {
    color: var(--primary-text-color);
    font-family: var(--paper-font-body1_-_font-family, var(--ha-font-family-body, Roboto, sans-serif));
  }
  * { box-sizing: border-box; }
  button { font: inherit; }
  .btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    min-height: 40px; padding: 0 16px; border-radius: 20px; cursor: pointer;
    border: 1px solid var(--divider-color); background: transparent;
    color: var(--primary-color); font-weight: 500; text-decoration: none;
  }
  .btn.primary { background: var(--primary-color); color: var(--text-primary-color, #fff); border-color: transparent; }
  .btn.danger { color: var(--error-color, #db4437); border-color: var(--error-color, #db4437); }
  .btn[disabled] { opacity: 0.5; cursor: default; }
  .btn ha-icon { --mdc-icon-size: 20px; }
  .icon-btn {
    display: inline-flex; align-items: center; justify-content: center;
    width: 44px; height: 44px; border-radius: 50%; border: none; cursor: pointer;
    background: transparent; color: inherit; padding: 0; flex: none;
  }
  .icon-btn:hover, .btn:hover { filter: brightness(0.95); }
  .icon-btn:focus-visible, .btn:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; }
  .field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 14px; }
  .field > label, .label { font-size: 0.85em; color: var(--secondary-text-color); font-weight: 500; }
  input[type="text"], input[type="number"], input[type="date"], input[type="search"],
  input[type="datetime-local"], select, textarea {
    font: inherit; width: 100%; min-height: 44px; padding: 8px 12px;
    border: 1px solid var(--divider-color); border-radius: 8px;
    background: var(--card-background-color, var(--primary-background-color));
    color: var(--primary-text-color);
  }
  textarea { min-height: 80px; resize: vertical; }
  input:focus, select:focus, textarea:focus { outline: 2px solid var(--primary-color); outline-offset: -1px; }
  .invalid input, .invalid select, .invalid textarea, input.invalid { border-color: var(--error-color, #db4437); }
  .error-text { color: var(--error-color, #db4437); font-size: 0.85em; }
  .hint { color: var(--secondary-text-color); font-size: 0.85em; }
  .row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  .row > .grow { flex: 1 1 140px; }
  .check { display: flex; align-items: center; gap: 10px; min-height: 40px; cursor: pointer; }
  .check input { width: 20px; height: 20px; accent-color: var(--primary-color); }
  .section {
    background: var(--card-background-color); border-radius: var(--ha-card-border-radius, 12px);
    border: 1px solid var(--divider-color); padding: 16px; margin-bottom: 16px;
  }
  .section h2 { font-size: 1.1em; margin: 0 0 12px; font-weight: 500; }
  .muted { color: var(--secondary-text-color); }
  .center { text-align: center; }
  .barcode-box {
    background: #ffffff; border-radius: 12px; padding: 16px; display: flex;
    flex-direction: column; align-items: center; gap: 8px;
  }
  .code-text {
    color: #000000; font-family: monospace; font-size: 1.2em; letter-spacing: 0.08em;
    word-break: break-all; text-align: center; user-select: all;
  }
  .links { display: flex; flex-wrap: wrap; gap: 8px; }
  .links a { color: var(--primary-color); }
`;
