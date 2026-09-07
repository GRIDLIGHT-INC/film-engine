# Film Engine for iOS

A **full replica** — it ships `src/index.html`, all 28 pages, inside a WKWebView.
Not a second implementation of them.

That is deliberate. `docs/plans/mobile-feasibility.md` already argued it: a native
rewrite's real cost is never the framework, it is **a second surface**, and this
codebase has paid three times over for two surfaces disagreeing — the plate
pointer, the frame pointer, `effectiveCamera`. One surface cannot drift from
itself.

## What is native

- **The server setup screen.** The engine runs on a Mac; the app has to be told
  where. It normalises what a person actually types (`192.168.4.40`, with or
  without scheme or port) and **checks the connection**, so a blank screen
  becomes a sentence.
- **A custom URL scheme** (`film-engine://`) rather than `file://`. WKWebView
  gives a `file://` page an opaque origin with **no localStorage**, and the SPA
  keeps the project selection, the API address and every editor preference
  there — it would come up blank on every launch.
- **ATS + local network permission.** The API is plain HTTP on a LAN address,
  which iOS blocks by default. `NSAllowsLocalNetworking` permits exactly the
  local network — deliberately *not* `NSAllowsArbitraryLoads`.

## Run it

```
open ios/FilmEngine.xcodeproj          # or:
xcodebuild -project ios/FilmEngine.xcodeproj -scheme FilmEngine \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

On the Mac running the engine, start the API so the phone can reach it:

```
node backend/server.js                 # binds every interface already
```

Then enter that Mac's LAN address in the app.

## Keep the bundle honest

`ios/FilmEngine/Web/index.html` is a **copy** of `src/index.html`. A copy that
drifts is the second surface this design exists to avoid, so re-sync after any
change to the SPA:

```
cp src/index.html ios/FilmEngine/Web/index.html
```

`backend/tests/ios-app.test.js` fails if the two differ by a single byte.

## TestFlight — the remaining step is yours

Everything buildable is built and verified: the project compiles, the app runs
on a simulator against the live API, and every Info.plist key and build setting
an upload requires is set (team `3AXRJ22S9P`, bundle id `ai.gridlight.filmengine`,
version 1.0 build 1, icon, `ExportOptions.plist` with `app-store-connect`).

**The archive and the export both work.** This section previously said Xcode had
no signed-in Apple ID and that archiving failed with `No Accounts`. That is no
longer true — an Apple ID is signed in, provisioning resolves automatically, and
both steps were run end to end on 2026-09-07:

```
xcodebuild -project ios/FilmEngine.xcodeproj -scheme FilmEngine \
  -configuration Release -destination 'generic/platform=iOS' \
  -archivePath build/FilmEngine.xcarchive -allowProvisioningUpdates archive
# ** ARCHIVE SUCCEEDED **

xcodebuild -exportArchive -archivePath build/FilmEngine.xcarchive \
  -exportOptionsPlist ios/ExportOptions.plist -exportPath build/export \
  -allowProvisioningUpdates
# ** EXPORT SUCCEEDED **  ->  build/export/FilmEngine.ipa
```

What comes out is TestFlight-ready, and worth checking rather than assuming —
a development signature archives happily and is rejected at upload:

| | |
|---|---|
| Signed by | `Apple Distribution: Gridlight, Inc. (3AXRJ22S9P)` |
| Profile | `iOS Team Store Provisioning Profile: ai.gridlight.filmengine` |
| `beta-reports-active` | `true` — the TestFlight entitlement |
| `get-task-allow` | `false` — correct for distribution, not development |
| Architecture | arm64, version 1.0 build 1, symbols uploaded |
| Web bundle inside | `Payload/FilmEngine.app/Web/index.html`, 2.5 MB |

**The remaining step is the upload, and it needs credentials this machine does
not hold** — no App Store Connect API key in `~/.appstoreconnect/private_keys`,
no app-specific password in the keychain. Two ways:

1. **Xcode Organizer** — Window → Organizer → the FilmEngine archive →
   *Distribute App* → App Store Connect. It signs in with the Apple ID already
   configured and needs no extra secret.
2. **Command line**, with an app-specific password or an ASC API key:

```
xcrun altool --upload-app -f build/export/FilmEngine.ipa -t ios \
  --apiKey <KEY_ID> --apiIssuer <ISSUER_ID>
```

**The app record must exist first.** App Store Connect → Apps → **+** → New App,
bundle id `ai.gridlight.filmengine`. Without it the upload fails with
*"No suitable application records were found"*, which reads like a signing
problem and is not.

## Using it once it is installed

The app is a window onto an engine running on your Mac; it does nothing on its
own.

1. On the Mac: `node backend/server.js` — it binds every interface, so the phone
   can reach it on the LAN.
2. In the app, enter that Mac's address. As of this writing it is
   **`192.168.4.40`** (interface `en2`); re-check with
   `ipconfig getifaddr en0` if the network changes.
3. iOS will ask for **local network** permission the first time. Refusing it
   makes every request fail silently, which looks exactly like the engine being
   down — that is why `NSLocalNetworkUsageDescription` is set.

The Mac and the phone must be on the same network, and the Mac must stay awake.

## Known limit before App Store review

TestFlight accepts this as it is. **App Store review guideline 4.2** can reject a
thin web wrapper, and the honest answer is that the native surface is currently
the setup screen. If it goes to public release rather than testing, the things
worth adding first are the ones a browser cannot do: camera capture straight
onto a reference plate, share-sheet export of a cut, and background upload.
