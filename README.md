# OpenIntreview Coder

> Your AI-powered interview preparation and real-time coding assistant.

[![Built with Electron](https://img.shields.io/badge/Built%20with-Electron-47848F?style=flat-square&logo=electron&logoColor=white)](https://www.electronjs.org/)
[![Powered by Gemini](https://img.shields.io/badge/Powered%20by-Gemini%20AI-4285F4?style=flat-square&logo=google&logoColor=white)](https://ai.google.dev/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green?style=flat-square)](LICENSE)

---

## About

**OpenIntreview Coder** is a desktop application designed to help developers during technical interviews. It combines screen analysis, voice interaction, and AI-powered code generation into a single lightweight tool.

Built on **Electron** and powered by **Google Gemini**, it runs locally on your machine with full privacy — no telemetry, no data collection.

### Key Capabilities

- **Screen Capture & Analysis** — Capture your screen and let AI analyze coding problems, system design diagrams, or technical questions instantly.
- **Voice Interaction** — Speak naturally and receive AI-generated solutions hands-free.
- **Conversational Memory** — Maintains context across your entire session so follow-up questions build on previous answers.
- **Multi-Skill Modes** — Specialized prompts for DSA, system design, programming, and technical screening.
- **Stealth Overlay** — Transparent, click-through windows that stay out of the way of screen sharing.
- **Cross-Platform** — Works on Windows, macOS, and Linux.

---

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18 or later)
- A [Google Gemini API Key](https://aistudio.google.com/)

### Installation

```bash
# Clone the repository
git clone https://github.com/SESHASHAYANAN/OpenIntreviewCoderV1.git
cd OpenIntreviewCoderV1

# Install dependencies
npm install

# Create your environment file
cp env.example .env
# Edit .env and add your GEMINI_API_KEY

# Start the application
npm start
```

Or use the one-line setup script:

```bash
./setup.sh
```

---

## Usage

| Action | Shortcut | Description |
|---|---|---|
| Capture Screen | `Ctrl+Shift+S` | Take a screenshot and send it to AI for analysis |
| Toggle Visibility | `Ctrl+Shift+V` | Show or hide all overlay windows |
| Toggle Interaction | `Ctrl+Shift+I` | Enable or disable clicking through overlays |
| Open Chat | `Ctrl+Shift+C` | Open the interactive chat panel |
| Settings | `Ctrl+,` | Open settings |

---

## Project Structure

```
├── main.js                  # Electron main process
├── src/
│   ├── core/                # Configuration and logging
│   ├── services/            # AI, speech, and screen capture services
│   ├── managers/            # Window and session management
│   └── ui/                  # UI window controllers
├── prompts/                 # Skill-specific AI prompt templates
├── setup.sh                 # One-line setup script
└── package.json
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop Framework | Electron |
| AI Backend | Google Gemini API |
| Speech | Web Speech API |
| Styling | CSS with glassmorphism effects |
| Build Tool | electron-builder |

---

## Building for Production

```bash
# Windows
npm run build:win

# macOS
npm run build:mac

# Linux
npm run build:linux

# All platforms
npm run build:all
```

---

## Privacy

- All processing happens locally on your machine.
- API calls to Gemini are encrypted end-to-end.
- No analytics, telemetry, or tracking of any kind.

---

## License

This project is licensed under the [MIT License](LICENSE).

---

**Developed by M.S.Seshashayanan**
