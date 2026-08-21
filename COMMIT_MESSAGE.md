Fix GlobeView resize on inset dismissal; add close button and toggle select

- Replace window.resize with ResizeObserver on mountRef container so renderer resizes when EncounterInset mounts/unmounts (frontend/src/components/GlobeView.tsx)
- Add close × button on locked inset; wire onCloseInset prop and handleCloseSelection to clear both selectedEvent and hoveredEvent (frontend/src/app/page.tsx)
- Implement click-to-toggle deselect on selected row (handleSelectEvent returns null on re-click)
- Add Jest + RTL test setup with Three.js/lucide mocks; 10 tests covering resize behavior and hover/selection semantics

All 10 frontend tests pass. Build clean.