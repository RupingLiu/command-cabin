# Quick Converter Design

## Goal

Add lightweight inline conversions to the launcher search box. When the user types a recognized unit or currency query, CommandCabin should show a top search result that can be opened to copy the conversion result.

The first version covers:

- Length: `cm`, `厘米`, `公分`, `mm`, `毫米`, `m`, `米`
- Weight: `kg`, `千克`, `公斤`, `g`, `克`, `lb`, `lbs`, `磅`
- Currency: `usd`, `USD`, `美元`, `美金` to `CNY`, `人民币`, `元`

## User Experience

The result should behave like the existing calculator result:

- Typing `1厘米` shows `1 厘米 = 10 毫米 = 0.01 米`.
- Typing `1cm` or `1公分` shows the same result.
- Typing `1千克` shows `1 千克 = 2.20462 磅`.
- Typing `1克` shows `1 克 = 0.00220462 磅`.
- Typing `1美元` shows `1 美元 ≈ 7.xx 人民币`.
- Pressing Enter or clicking the result copies the result text to the clipboard.

The query parser should accept optional whitespace between number and unit, such as `1 cm` and `1 美元`. It should support decimal numbers such as `2.5kg`.

## Recommended Architecture

Create a new built-in package named `@command-cabin/built-in-plugin-quick-converter`.

This should be separate from the calculator package because unit parsing, formatting, exchange-rate fetching, and cache behavior are different concerns from mathematical expression evaluation. The launcher command service can register quick-converter dynamic commands in the same way it registers the existing calculator command.

Suggested public API:

- `createQuickConverterCommand(query, options): Promise<Command | undefined>`
- `createStaticConversionCommand(query): Command | undefined`
- `parseConversionQuery(query): ParsedConversionQuery | undefined`
- `createExchangeRateProvider(options): ExchangeRateProvider`

Static length and weight conversions can be computed synchronously. Currency conversion needs an async path because it may fetch and cache live rates. `LauncherCommandService.searchCommands` should become async, while the renderer/preload IPC contract can remain promise-based as it already is.

## Data Flow

1. Renderer sends the current search query through the existing search IPC.
2. Main process awaits `launcherCommandService.searchCommands(query)`.
3. The service refreshes dynamic utility commands before searching:
   - calculator result
   - quick converter result
4. For length and weight queries, quick converter returns immediately.
5. For USD/CNY queries, quick converter:
   - reads an in-memory cache mirror loaded from `exchange-rates.json`,
   - awaits a live fetch with a short timeout,
   - returns a live result when available,
   - falls back to the most recent cached result if the live fetch fails.
6. The generated command uses `copy-text` with the formatted conversion text.

## Exchange Rate Provider

Use Frankfurter for the first implementation:

- Endpoint: `https://api.frankfurter.dev/v2/rate/USD/CNY`
- No API key required.
- Single-pair endpoint keeps the response small.

Cache the latest successful USD/CNY rate in a small JSON file under Electron `userData`, for example `exchange-rates.json`. The cache record should include:

- base currency: `USD`
- quote currency: `CNY`
- rate
- provider: `Frankfurter`
- provider date or update timestamp
- local fetched-at timestamp

The result subtitle should communicate freshness:

- Live result: `实时汇率 · 更新时间 2026-05-18`
- Cached result: `缓存汇率 · 更新时间 2026-05-17`
- No live or cached rate: no currency command result.

## Parsing Rules

The parser should be intentionally narrow for version 1.

Supported form:

```text
<number><optional spaces><unit>
```

Examples:

- `1厘米`
- `1 cm`
- `2.5kg`
- `100 克`
- `1 USD`
- `1美元`

Do not parse compound expressions such as `1kg + 2g`, reverse currency such as `人民币换美元`, or full natural language such as `一美元等于多少人民币` in the first version.

## Formatting Rules

Use concise, readable decimal formatting:

- Trim unnecessary trailing zeroes.
- Keep enough precision for small values.
- Use `≈` for currency because exchange rates are market data.
- Use `=` for exact unit conversions.

Suggested precision:

- length: up to 6 significant decimal places
- weight: up to 6 significant decimal places
- currency: 2 decimal places by default

## Error Handling

Currency fetch failures should not block search results for apps, files, or static conversions.

If live fetch fails and a cached rate exists, return the cached conversion result. If no cached rate exists, skip the currency result so the user still sees normal search results. Log the fetch failure in the main process for diagnostics without showing a blocking dialog.

Network requests should have a short timeout so typing in search remains responsive.

## Testing

Add unit tests for:

- parsing each supported alias
- rejecting unrecognized or compound input
- exact length conversions
- exact weight conversions
- currency live result formatting
- currency cached fallback when fetch fails
- no currency command when both live fetch and cache are unavailable
- launcher command service registering quick-converter results without breaking calculator results

Add an integration-style desktop test for searching `1厘米`, `1千克`, and `1美元` through the command service.

## Out of Scope

The first version will not include:

- more currencies
- reverse currency conversion from CNY to USD
- temperature conversion
- area or volume conversion
- settings UI for enabling/disabling individual converters
- natural-language Chinese numerals
