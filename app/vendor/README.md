# Vendored FriendSDK

`rarefriends-friendsdk-0.1.2.tgz` is the official package from
<https://github.com/spokesz/friendsdk/releases/tag/v0.1.2>, produced with `npm pack`.

It is vendored here because the SDK is **not published to npm** (their CHANGELOG says
publication "is not planned"), and a deploy has no other way to install it.

We use it as a **library, not a runtime**: `renderWorld` draws the hall, `createWorldMovement`
handles walking and collision, `project`/`unproject` map between world and screen. We do not
use `GameHost`, because its identity gate requires a Generations NFT of generation >= 1 and
therefore excludes every Genesis.

Licence: Apache-2.0, see `LICENSE-friendsdk`. Artwork permissions: `NOTICE-friendsdk.md`,
which permits use and modification of SDK artwork in finished projects with attribution.
