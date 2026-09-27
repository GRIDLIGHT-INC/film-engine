# Third-party notices

Film Engine includes the following open-source software, redistributed under
their own licences.

| Component | Version | Where | Licence |
|---|---|---|---|
| [three.js](https://github.com/mrdoob/three.js) | r149 | inlined in `src/index.html` (with `GLTFLoader`) | MIT — Copyright © 2010-2025 three.js authors |
| [three.js](https://github.com/mrdoob/three.js) | 0.180.0 | bundled in `src/vendor/splat-viewer.js` | MIT — Copyright © 2010-2025 three.js authors |
| [Spark](https://github.com/sparkjs-dev/spark) (`@sparkjsdev/spark`) | 2.2.0 | bundled in `src/vendor/splat-viewer.js` | MIT — Copyright © 2025 World Labs Technologies, Inc. |

Installed from npm at `npm install` time (not redistributed in this
repository): [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) (MIT)
and [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) (GPL-3.0 for
the downloaded ffmpeg binary; the package itself is MIT). Using a system ffmpeg
instead is supported — see `FFMPEG_PATH` in the README.

The MIT licence text for each component:

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
