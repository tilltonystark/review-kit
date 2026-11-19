# Review Kit

Click any element on your website, write what should change, and it lands on GitHub, where Claude picks it up, fixes it on a branch and opens a pull request.

- Works on any site: one `<script>` tag, no framework needed.
- Safe on a live site: hidden from visitors, only reviewers with a private review link can comment.
- The GitHub token stays on your server (or a free relay for static sites), never in the browser.
- Each comment carries the page, the element's selector, size, spacing, styles, device and a screenshot.

> Status: early. Milestone 1 (widget + server handler) is in. The Claude skill and the full getting-started guide are coming next.

## Development

```bash
npm install
npm test          # server handler tests
npm run build     # widget -> dist/widget, server -> dist/server
npm run e2e       # browser test on desktop and phone (needs Playwright)
```

MIT licence.
