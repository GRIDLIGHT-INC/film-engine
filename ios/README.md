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

## Signing

The project ships with **no development team set**, so it builds for the
simulator out of the box and signs with whoever builds it. To run it on a device
or upload it, open `ios/FilmEngine.xcodeproj`, select the FilmEngine target →
*Signing & Capabilities* → pick your **Team**, and change the bundle id
(`ai.gridlight.filmengine`) to one you own. For an App Store export, put your
Team ID in `ios/ExportOptions.plist` in place of `YOUR_TEAM_ID`.

## TestFlight — the remaining step is yours

Everything buildable is built and verified: the project compiles, the app runs
on a simulator against the live API, and every Info.plist key and build setting
an upload requires is set (your own team — see *Signing* below; bundle id `ai.gridlight.filmengine`,
version 1.0 build 3, icon, `ExportOptions.plist` with `app-store-connect`).

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
| Signed by | `Apple Distribution: <your team>` |
| Profile | `iOS Team Store Provisioning Profile: ai.gridlight.filmengine` |
| `beta-reports-active` | `true` — the TestFlight entitlement |
| `get-task-allow` | `false` — correct for distribution, not development |
| Architecture | arm64, version 1.0 build 3+ (Xcode bumps the App Store copy on export), symbols uploaded |
| Web bundle inside | `Payload/FilmEngine.app/Web/index.html`, 2.5 MB |

**The remaining step is the upload, and it needs credentials this machine does
not hold** — no App Store Connect API key in `~/.appstoreconnect/private_keys`,
no app-specific password in the keychain. Two ways:

1. **Xcode Organizer** — Window → Organizer → the FilmEngine archive →
   *Distribute App* → App Store Connect. It signs in with the Apple ID already
   configured and needs no extra secret.

   **THE ARCHIVE ABOVE WILL NOT APPEAR THERE.** Organizer lists only what is
   under `~/Library/Developer/Xcode/Archives/<date>/`; `-archivePath
   build/FilmEngine.xcarchive` puts it in the repo, where Organizer never
   looks — so the window comes up with the app missing from the list and
   nothing says why. Either archive from Xcode instead (**Product → Archive**,
   which files it correctly), or move the one you built:

   ```
   D=~/Library/Developer/Xcode/Archives/$(date +%Y-%m-%d)
   mkdir -p "$D"
   cp -R build/FilmEngine.xcarchive "$D/FilmEngine $(date '+%d-%m-%Y, %H.%M').xcarchive"
   ```

   The comma in that name is Xcode's own convention, and the archive's own
   `SigningIdentity` reads *Apple Development* — that is correct and not a
   problem: Xcode archives with a development identity and **re-signs with
   distribution when you distribute**, which is why the exported `.ipa` comes
   out signed `Apple Distribution`.
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

## Shooting a plate on the phone

The one thing here that is native rather than web, and the reason is narrow.

The page already has a Shoot button — `uploadControl()` appends an
`<input type="file" capture="environment">` and WKWebView opens the camera for
it. That is all a browser offers: **one photograph per tap**, with nothing on
screen saying which view you are on.

A reference plate is usually not one picture. A character turnaround is front,
left, right and back — `VIEW_RANK` in `backend/lib/plate-views.js` ranks exactly
those, and the front one is attached to every frame that character appears in.
Walking four through a file input means four trips out to the page and back,
hunting for the next control each time.

So `PlateCamera.swift` walks them in one pass, with the subject and the view on
screen and a `2 of 4`, uploading each as it goes.

**The page still decides everything.** It posts the subject, the views and the
import route; native opens the camera and posts back to *that same route* with
the same body the web path sends (`{ data, view, name }`). Native constructs no
URL and knows no subject — deciding in two places is the second surface this
whole design exists to avoid, and `backend/tests/ios-app.test.js` holds both
sides to it: the handler name, the callback name, the body, and the fact that
the browser fallback is still there.

Notes worth keeping:

- **A simulator has no rear camera.** `AVCaptureDevice.default` returns nil and
  the session says so in words. A black screen with a dead shutter is
  indistinguishable from a broken app.
- **A failed upload keeps the photograph** and names the view it belonged to.
  Discarding it would make a director shoot it again.
- **Skip is offered**, because a director may not be able to reach the far side
  of a thing and refusing to move on would strand the session on one view.
- JPEG at 0.9, not PNG: a 12-megapixel PNG is tens of megabytes, and uploads
  travel base64 — a third larger again — over a phone's network.

## Known limit before App Store review

TestFlight accepts this as it is. **App Store review guideline 4.2** can reject a
thin web wrapper. The native surface is now the setup screen **and the guided
plate camera** above, which is a real capability rather than chrome. If it goes
to public release rather than testing, the next things worth adding are the
other two a browser cannot do: share-sheet export of a cut, and background
upload.
