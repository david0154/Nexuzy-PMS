# Contributing to Nexuzy PMS

Thank you for your interest in contributing to Nexuzy PMS, an open-source hospitality management platform!

## Development Workflow

1. Fork the repository on GitHub.
2. Clone your fork locally:
   ```bash
   git clone https://github.com/<your-username>/nexuzy-pms.git
   cd nexuzy-pms
   ```
3. Install dependencies:
   ```bash
   npm install
   ```
4. Run integration tests:
   ```bash
   npm test
   ```
5. Create a descriptive feature branch:
   ```bash
   git checkout -b feature/your-feature-name
   ```
6. Commit your changes and push to your fork:
   ```bash
   git push origin feature/your-feature-name
   ```
7. Open a Pull Request against `main`.

## Code Guidelines
- Keep business logic in `server/modules/` with transaction safety.
- Always include automated test coverage in `test/run-tests.js` for new workflows.
- Preserve backward compatibility for `.nxp` backup packages.
