# Soft Wellness UI Refresh Design

## Goal

CommandCabin should feel polished enough to hand to users while preserving its fast launcher
workflow. The current visual system reads as industrial: dark olive surfaces, grid texture, hard
8px panels, thin borders, and muted yellow-green accents. The refresh should replace that with a
soft, rounded, frosted interface inspired by modern wellness dashboards: light and dark themes,
clear hierarchy, subtle translucency, and warm red, blue, green, and orange accents.

## Design Direction

Use the approved "frosted compact" direction:

- Keep the launcher dense enough for keyboard-first productivity.
- Remove industrial grid textures and heavy panel outlines.
- Use a clean light theme and a cohesive dark theme through the existing theme preference.
- Prefer rounded translucent surfaces, soft shadows, and colorful functional accents.
- Keep component states obvious: focus, hover, selected, disabled, busy, success, and error.

The redesign is mostly a renderer styling pass. It should not change command search behavior,
settings persistence, IPC contracts, screenshot capture logic, or plugin execution behavior.

## Scope

Apply the refreshed visual system to:

- Launcher shell, title area, brand mark, search input, result list, recent app grid, home action
  buttons, update banner, state panels, loading skeletons, context menu, and add-app picker.
- Settings shell, setting sections, segmented controls, toggles, badges, form inputs, plugin rows,
  favorites editor, clipboard history settings, and data/about panels.
- Unit converter shell, category controls, value inputs, select controls, and swap button.
- Plugin host frame, titlebar, close button, fallback state, and webview container.
- Screenshot overlay surfaces: selection size badge, toolbar, tool groups, buttons, swatches,
  format controls, OCR/pin/save/done/cancel actions, status toast, OCR panel, text annotation input,
  and text annotation action buttons.
- Pinned image window titlebar and close button.

## Theme Tokens

Replace the existing olive/industrial palette with semantic renderer variables. Keep the existing
`data-theme='light'` and `data-theme='dark'` root mechanism.

Light theme:

- App background: near-white to pale blue-gray, with subtle red and blue radial washes.
- Surfaces: translucent white with restrained blur-compatible shadows.
- Text: high-contrast near-black title text and softer blue-gray secondary text.
- Accent: warm red/pink for primary focus and selection, blue for secondary actions, green for
  success/confirm, orange for warm highlights.
- Borders: soft translucent white and pale blue-gray, not dark grid lines.

Dark theme:

- App background: deep neutral blue-black with soft red and blue radial washes.
- Surfaces: translucent white overlays on dark background.
- Text: near-white title text and muted blue-gray secondary text.
- Accent: brighter red/pink, system-like blue, green success, and orange highlights.
- Borders: low-contrast translucent white.

Shared tokens should cover focus rings, panel backgrounds, button backgrounds, icon backgrounds,
danger states, skeleton colors, scrollbar colors, and shadows. Settings variables should continue
to alias app-level variables so the settings UI does not drift visually.

## Component Treatment

Launcher:

- The main shell keeps the full-window launcher layout but gets softer outer spacing and no grid
  texture.
- The search field becomes the strongest surface: taller, rounded, lightly translucent, and clear
  under focus.
- Results use rounded frosted rows. The selected result uses a warm accent edge and subtle lift.
- Recent apps remain compact but become softer tiles with clearer app icons and less border noise.
- Home action buttons become compact pill controls with icon badges.
- Update and empty/error states use the same surface language instead of dashed industrial panels.
- The add-app picker becomes a larger floating frosted panel with rounded search and rows.

Settings:

- Keep the current single-scroll settings structure.
- Change sections from stark top-border divisions into soft grouped surfaces or lightly separated
  bands.
- Inputs, segmented controls, toggles, and badges should share the same rounded token set.
- Error text remains compact and visible, using the danger token.

Converter and plugin host:

- Match the launcher and settings shells.
- Converter inputs and category controls should feel like the same control family as launcher home
  actions.
- Plugin host should avoid looking like an old framed webview; use a soft outer shell and rounded
  webview container.

Screenshot overlay:

- Preserve the captured screen as the primary visual content. Do not add decorative backgrounds to
  the screenshot stage.
- Keep the selection overlay legible and precise, with a warm accent border and a clear outside
  dimmer.
- Convert the toolbar into a dark frosted floating capsule. This keeps it readable over arbitrary
  desktop content and visually related to the dark theme.
- Keep the existing toolbar order and actions. Only restyle surfaces, groups, active states,
  disabled states, swatches, and feedback panels.
- Use warm accent for active tools, green for done/confirm, muted surfaces for cancel/secondary
  actions, and red for error surfaces.
- Restyle OCR panel, status toast, size badge, and text editor to match the same floating surface
  language.

Pinned image:

- Keep the tiny utility-window structure.
- Use a soft dark titlebar and rounded close button so it does not feel detached from the screenshot
  overlay.

## Accessibility And Fit

- Preserve existing ARIA labels, roles, keyboard handling, and focus behavior.
- Keep text within fixed controls at current supported window sizes.
- Do not reduce contrast below readable levels in either theme.
- Respect reduced-motion behavior already present in CSS.
- Avoid layout shifts when hover, selected, busy, or disabled states appear.

## Architecture

- Implement primarily in `apps/desktop/src/renderer/src/app/App.css`.
- Make small TSX edits only if needed for visual hooks or brand mark color cleanup.
- Keep theme application in `ThemeSettings.tsx` and `App.tsx` unchanged unless a bug is discovered.
- Do not introduce a new component library or icon package for this pass.
- Do not change shared IPC parsers, core search logic, storage, plugin runtime, or screenshot canvas
  composition.

## Testing

- Run renderer-focused tests that cover the main touched surfaces:
  - `apps/desktop/src/renderer/src/app/App.test.ts`
  - `apps/desktop/src/renderer/src/app/themeCss.test.ts`
  - launcher tests for result rendering and accessibility
  - settings page tests
  - unit converter tests
  - screenshot overlay toolbar tests
- Run `corepack pnpm typecheck`.
- Run `corepack pnpm test` if targeted tests pass.
- Use the local app/browser to visually inspect launcher, settings, converter, and screenshot
  toolbar in both light and dark themes.

## Out Of Scope

- Changing command ranking, app discovery, plugin permissions, update behavior, or screenshot
  annotation logic.
- Adding new user-facing copy except where a visual hook is unavoidable.
- Replacing handmade toolbar glyphs with a full icon system.
- Changing packaging, persistence, migrations, or IPC contracts.
