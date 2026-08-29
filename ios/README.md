# Film Engine for iOS

A **full replica** — it ships `src/index.html`, all 38 pages, inside a WKWebView.
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

**Archiving is blocked on one thing I cannot do:** Xcode has no signed-in Apple
ID. `xcodebuild … archive` reports:

```
error: No Accounts: Add a new account in Accounts settings.
error: No profiles for 'ai.gridlight.filmengine' were found
```

It needs your Apple ID and 2FA. Once signed in:

1. **Xcode → Settings → Accounts → +** → Apple ID → sign in to the Gridlight team.
2. **App Store Connect → Apps → +** → new app, bundle id `ai.gridlight.filmengine`.
3. Archive and upload:

```
xcodebuild -project ios/FilmEngine.xcodeproj -scheme FilmEngine \
  -configuration Release -destination 'generic/platform=iOS' \
  -archivePath build/FilmEngine.xcarchive -allowProvisioningUpdates archive

xcodebuild -exportArchive -archivePath build/FilmEngine.xcarchive \
  -exportOptionsPlist ios/ExportOptions.plist -exportPath build/export \
  -allowProvisioningUpdates
```

Step 1 also creates the App ID and provisioning profile automatically, which is
what the two errors above are asking for.

## Known limit before App Store review

TestFlight accepts this as it is. **App Store review guideline 4.2** can reject a
thin web wrapper, and the honest answer is that the native surface is currently
the setup screen. If it goes to public release rather than testing, the things
worth adding first are the ones a browser cannot do: camera capture straight
onto a reference plate, share-sheet export of a cut, and background upload.
