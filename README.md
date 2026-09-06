# Lodestone

Local semantic search over your files via MCP.

Lodestone can also mirror selected email accounts into read-only `Mail: …` silos. Messages and attachment metadata are stored locally as searchable Markdown without changing the server; supported attachment content is downloaded only for an explicit on-demand read and is not retained. See the [email mirror documentation](docs/email-mirror/00-overview.md) for the design and setup details.

Searches can be restricted to an inclusive date window. Email results use the server-received time and other files use their last modified time. A search with no query and a date window lists everything in the window newest first, with the total count. See the [date-filter documentation](docs/date-filter/00-overview.md) for the design and client behaviour.

## Development

```bash
npm install
npm start
```

## License

MIT
