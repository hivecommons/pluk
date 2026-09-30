- Add opt-in `--diagnostics[=ms]` health diagnostics for `pluk watch` and
  `pluk subscribe`, periodically reporting bounded, local-only counters
  (capture/poll failures, malformed or skipped events, events processed) to
  stderr, so operators can distinguish a healthy quiet session from a
  watcher that is repeatedly failing or discarding input. No exporter is
  added and nothing is sent off-box (closes #102).
