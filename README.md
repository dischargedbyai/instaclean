# InstaClean

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/Chrome%20Extension-Manifest%20V3-1a73e8.svg)](manifest.json)
[![Design](https://img.shields.io/badge/UI-Google%20Material%203-1e8e3e.svg)](popup/popup.html)

A fast, lightweight Chrome Extension (Manifest V3) built with an authentic **Google Material Design 3** interface that automates selecting and batch-cleaning your activity on Instagram:

* **Likes**: [`https://www.instagram.com/your_activity/interactions/likes/`](https://www.instagram.com/your_activity/interactions/likes/)
* **Reposts**: [`https://www.instagram.com/your_activity/interactions/reposts/`](https://www.instagram.com/your_activity/interactions/reposts/)

---

## Features

* **Dual-mode automation (Likes & Reposts)**:
  * Seamless mode switcher with **[Likes]** and **[Reposts]** pill controls.
  * **Auto-detection**: Dynamically detects the active page URL and switches between targeting the red **"Unlike"** button (for likes) and red **"Delete"** button (for reposts).
  * Direct 1-click navigation between activity pages.

* **Single-click selection & ID tracking**:
  * Employs unique post identifiers (URL slug and CDN hash tracking) so each post card is clicked exactly once.
  * Eliminates double-toggle unselection glitches when scrolling down long feeds.

* **DOM pagination auto-refresh**:
  * Automatically reloads the feed 2 seconds after completing a batch, resolving Instagram's virtualized Relay store pagination freeze.
  * Includes an **Auto-resume** option for continuous multi-batch cleaning.

* **Draggable in-page overlay widget**:
  * Move the control card anywhere across the viewport.
  * Bounds-checked to prevent moving off-screen and remembers your preferred location.
  * Clean, minimal Google Material sentence-case typography (no all-caps headers or robotic UI text).

* **Account-safe pacing**:
  * Human-like delays with randomized timing jitter (+/- 15%) to prevent spam detection.
  * Three selectable pacing modes:
    * **Fast**: ~400ms delay per selection.
    * **Balanced**: ~750ms delay (recommended).
    * **Safe**: ~1500ms delay for high-volume accounts.
  * Strict safety limit clamped to a maximum of 50 items per run.

---

## Installation

1. Clone or download this repository:
   ```bash
   git clone https://github.com/dischargedbyai/unlike-posts.git
   ```
2. Open Google Chrome (or any Chromium browser such as Brave, Edge, or Arc).
3. Navigate to:
   ```text
   chrome://extensions/
   ```
4. Enable **Developer mode** using the toggle in the upper right corner.
5. Click **Load unpacked** in the top left.
6. Select the project folder.

---

## How to Use

1. Open your Instagram activity page:
   * **Likes**: [`https://www.instagram.com/your_activity/interactions/likes/`](https://www.instagram.com/your_activity/interactions/likes/)
   * **Reposts**: [`https://www.instagram.com/your_activity/interactions/reposts/`](https://www.instagram.com/your_activity/interactions/reposts/)
2. The in-page widget or popup will recognize the page and highlight the active mode.
3. Select your desired item limit (e.g. 10, 20, 30, or 50 max).
4. Click **Unlike posts** or **Delete reposts**.
5. InstaClean will activate selection mode, select items with humanized delays, click the red action button, confirm the modal prompt, and reload your feed with fresh posts.

---

## Project Structure

```text
├── manifest.json         # Manifest V3 extension configuration
├── LICENSE               # MIT License
├── README.md             # Documentation
├── background/
│   └── background.js     # Service worker handling state and badge updates
├── content/
│   ├── content.js        # DOM automation, click dispatchers, and widget controller
│   └── content.css       # Material Design 3 styles for in-page overlay
├── popup/
│   ├── popup.html        # Clean sentence-case extension popup
│   ├── popup.css         # Popup styles and Material color tokens
│   └── popup.js          # Popup controller and preference persistence
└── icons/
    ├── icon.svg          # Master vector icon
    ├── icon16.png        # 16x16 toolbar icon
    ├── icon32.png        # 32x32 UI icon
    ├── icon48.png        # 48x48 manager icon
    └── icon128.png       # 128x128 store display icon
```

---

## Packaging for Chrome Web Store

To create a clean release package excluding development files:

```bash
zip -r instaclean-extension.zip manifest.json icons/ content/ popup/ background/
```

---

## License

This project is licensed under the [MIT License](LICENSE) - Copyright (c) 2026 Priyanshu (dischargedbyai).
