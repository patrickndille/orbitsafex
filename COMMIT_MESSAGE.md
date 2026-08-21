Fix test unpacking, camera snap refactor, restore production DB, rewrite docs

- Fix test_run_conjunction_scan_returns_position_fields: unpack tuple return from run_conjunction_scan() (backend/tests/test_orbital_math.py:596)
- Refactor GlobeView camera snap: replace broken renderer._scene traversal with shared useRef (frontend/src/components/GlobeView.tsx)
- Restore production orbitsafe.db to pre-work state (57,344 bytes) via git checkout HEAD
- Rewrite NOTES.md: remove fabricated claims, document completed work, add scientific limitations and auto-spin disclaimer

All 21 tests pass. Frontend builds clean. Production DB untouched.