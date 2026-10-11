# On-Demand Webcam

A privacy-first, single-viewer WebRTC application that turns a camera owner's device into an on-demand webcam. The camera is **OFF by default** and is only requested after the owner approves a viewer request and explicitly clicks the start-camera control.

## Architecture

- **Client:** React + TypeScript + Vite + Tailwind CSS
- **Server:** Node.js + Express + Socket.IO
- **Database:** SQLite via better-sqlite3 for development/small deployments
- **Auth:** HTTP-only signed session cookie backed by SQLite
- **Transport:** WebRTC peer-to-peer video; Socket.IO is signaling only
- **Authorization:** Server validates owner session and viewer room token before signaling
- **Mode:** One approved viewer per room

### Signaling flow

1. Viewer opens `/view/:token`.
2. Server validates the opaque, expiring viewer token and returns room metadata.
3. Viewer clicks **Request access**; Socket.IO sends `viewer:request` to the owner.
4. Owner explicitly clicks **Approve** or **Reject**.
5. If approved, owner explicitly clicks **Start camera**. Only then does the browser call `getUserMedia({ video: true, audio: false })`.
6. Owner creates a WebRTC offer and sends it through Socket.IO.
7. Viewer creates the answer and sends it back.
8. Both peers exchange ICE candidates.
9. On viewer stop/disconnect, the server emits a revoke/disconnect event; owner closes the peer connection and stops every local camera track when no approved viewer remains.

### Camera lifecycle

`Camera Off -> Waiting for Approval -> Approved/Start Required -> Connecting -> Camera Live -> Stop/Disconnect -> Camera Off`

The owner has a persistent **Stop Camera Now** action. Every local track is stopped with `track.stop()`, the video element is detached, and the peer connection is closed.

## Limitations

- Browser camera permissions cannot be bypassed. Production must use HTTPS (localhost is allowed for development).
- A user can deny or revoke camera permission in browser/OS settings.
- WebRTC may require STUN/TURN for NAT/firewall traversal. Configure `TURN_URL`/`TURN_USERNAME`/`TURN_CREDENTIAL` in production; the sample uses a public STUN server by default.
- Direct P2P is intentionally limited to one viewer. For multiple viewers, use an SFU such as LiveKit, mediasoup, Janus, or Jitsi.
- Mobile browsers can suspend background tabs or stop timers. Keep the owner page visible while serving the camera.
- The server never receives the media stream. Video is not recorded by this project.

## Setup

Requirements: Node.js 20+ and npm 10+.

```bash
cp server/.env.example server/.env
cp client/.env.example client/.env
npm install
npm run dev
```

Open `http://localhost:5173` in two browsers/devices. Create a camera room in one and open the generated viewer link in the other. The client defaults to the local backend at `http://localhost:3000` when `VITE_API_URL` and `VITE_SOCKET_URL` are not set.

## Environment

See `server/.env.example`. Generate a long random `SESSION_SECRET` and keep it out of source control.

## Production HTTPS

Build:

```bash
npm run build
NODE_ENV=production npm start
```

Put the Express server behind a TLS reverse proxy such as Nginx/Caddy/Cloudflare. The browser-facing URL must be HTTPS. Proxy WebSocket upgrade traffic to `/socket.io/`.

Example Caddy concept:

```text
camera.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

Set `APP_ORIGIN=https://camera.example.com` and configure a TURN server for reliable WebRTC across restrictive networks.

## Testing

### Two browsers

1. Browser A: create owner room.
2. Browser B: open viewer link.
3. In B click Request access.
4. In A confirm the request appears while status remains **Waiting for approval** and no camera permission prompt has occurred.
5. In A click Approve, then **Start camera**. Browser A's normal camera permission prompt appears if permission has not already been granted.
6. Verify B receives video.
7. In B click Stop watching. Verify A returns to Camera Off and the camera indicator disappears.
8. Reject a request and verify B cannot receive video.
9. Use A's **Stop Camera Now** while live and verify B is disconnected.

### Mobile

Use the same flow with an iPhone/Android browser over HTTPS. For LAN development, use a local HTTPS certificate (for example with mkcert) because mobile browsers do not treat arbitrary HTTP LAN origins as secure contexts.

## Security notes

- Viewer tokens are 256-bit random values, stored only as SHA-256 hashes, and expire.
- Owner authorization is server-side and based on an HTTP-only, SameSite cookie.
- Viewer authorization is checked on every Socket.IO connection and signaling event.
- Only the currently approved viewer can signal.
- Request rate limiting protects the HTTP access-request endpoint and Socket.IO request event.
- Helmet adds standard HTTP security headers.
- CORS is restricted to `APP_ORIGIN`.
- Video is not stored by the server.
- Microphone is never requested.
- No camera API is called on initial page load.

## Troubleshooting

- **Camera permission denied:** allow camera access in browser/OS settings, then reload and approve again.
- **Room not found/expired:** create a new room or regenerate the viewer link.
- **Owner offline:** viewer cannot receive approval until owner reconnects.
- **Connecting forever:** check HTTPS, firewall/NAT, and TURN configuration.
- **No video after approval:** ensure owner clicked Start camera and that the selected camera is not already exclusively used by another application.
- **Socket disconnects:** check reverse-proxy WebSocket support and `APP_ORIGIN`.
