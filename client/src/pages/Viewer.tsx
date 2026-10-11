
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { createSocket } from '../lib/socket';
import { StatusBadge } from '../components/StatusBadge';

const ICE: RTCIceServer[] = [
  {
    urls:
      import.meta.env.VITE_STUN_URL ??
      'stun:stun.l.google.com:19302',
  },
];

if (import.meta.env.VITE_TURN_URL) {
  ICE.push({
    urls: import.meta.env.VITE_TURN_URL,
    username: import.meta.env.VITE_TURN_USERNAME,
    credential: import.meta.env.VITE_TURN_CREDENTIAL,
  });
}

export function Viewer() {
  const { token = '' } = useParams();

  const [roomId, setRoomId] = useState('');
  const [status, setStatus] = useState<
    'off' | 'waiting' | 'connecting' | 'live' | 'error'
  >('off');
  const [error, setError] = useState('');
  const [canRequest, setCanRequest] = useState(false);

  const video = useRef<HTMLVideoElement>(null);
  const socket = useRef<any>(null);
  const pc = useRef<RTCPeerConnection | null>(null);
  const pendingIceCandidates = useRef<RTCIceCandidateInit[]>([]);

  function stopPeer() {
    pc.current?.close();
    pc.current = null;
    pendingIceCandidates.current = [];

    if (video.current) {
      video.current.srcObject = null;
    }

    setStatus('off');
    setCanRequest(!!socket.current?.connected);
  }

  function disconnectAll() {
    pc.current?.close();
    pc.current = null;

    if (video.current) {
      video.current.srcObject = null;
    }

    socket.current?.emit('viewer:stop');
    socket.current?.disconnect();
    socket.current = null;

    setCanRequest(false);
  }

  useEffect(() => {
    let alive = true;

    async function initializeViewer() {
      try {
        const response = await api.get(
          `/api/view/${encodeURIComponent(token)}`
        );

        if (!alive) return;

        const currentRoomId = response.data.roomId;
        setRoomId(currentRoomId);

        const s = createSocket({
          role: 'viewer',
          roomId: currentRoomId,
          token,
        });

        socket.current = s;

        s.on('connect', () => {
          if (alive) setCanRequest(true);
        });

        s.on('connect_error', (e: Error) => {
          if (!alive) return;

          setError(
            e.message === 'Unauthorized viewer socket'
              ? 'This viewer link is invalid or expired.'
              : 'Could not connect to the room.'
          );
          setStatus('error');
        });

        s.on('access:pending', () => {
          if (alive) setStatus('waiting');
        });

        s.on('access:owner-offline', () => {
          if (!alive) return;
          setStatus('error');
          setError('Camera owner is offline.');
        });

        s.on('access:busy', () => {
          if (!alive) return;
          setStatus('error');
          setError('Another viewer is already using this room.');
        });

        s.on('access:rejected', () => {
          if (!alive) return;
          setStatus('error');
          setError('The camera owner rejected access.');
        });

        s.on('access:revoked', () => {
          if (!alive) return;
          stopPeer();
          setError('The owner stopped camera access.');
        });

        s.on(
          'webrtc:signal',
          async ({
            from,
            data,
          }: {
            from: string;
            data: any;
          }) => {
            if (!alive) return;

            try {
              if (data.type === 'offer') {
                setStatus('connecting');

                // Close an older peer connection if one exists.
                pc.current?.close();

                const p = new RTCPeerConnection({
                  iceServers: ICE,
                });

                pc.current = p;

                p.ontrack = (event) => {
                  if (video.current) {
                    video.current.srcObject = event.streams[0];
                    video.current.play().catch(() => {});
                  }
                };

                p.onicecandidate = (event) => {
                  if (event.candidate) {
                    socket.current?.emit('viewer:signal', {
                      to: from,
                      data: {
                        candidate: event.candidate,
                      },
                    });
                  }
                };

                p.onconnectionstatechange = () => {
                  if (!alive) return;

                  if (p.connectionState === 'connected') {
                    setStatus('live');
                  }

                  if (
                    ['failed', 'closed', 'disconnected'].includes(
                      p.connectionState
                    )
                  ) {
                    stopPeer();
                  }
                };

                await p.setRemoteDescription(data);
                for (const candidate of pendingIceCandidates.current) {
                  await p.addIceCandidate(candidate);
                }
                pendingIceCandidates.current = [];

                const answer = await p.createAnswer();
                await p.setLocalDescription(answer);

                socket.current?.emit('viewer:signal', {
                  to: from,
                  data: answer,
                });
              } else if (data.candidate) {
                if (pc.current?.remoteDescription) {
                  await pc.current.addIceCandidate(data.candidate);
                } else {
                  pendingIceCandidates.current.push(data.candidate);
                }
              }
            } catch (e) {
              console.error('WebRTC signal error:', e);

              if (alive) {
                setStatus('error');
                setError('WebRTC connection failed.');
              }
            }
          }
        );
      } catch (e: any) {
        if (!alive) return;

        setStatus('error');
        setError(
          e?.response?.data?.error ??
            'This viewer link is invalid or expired.'
        );
      }
    }

    initializeViewer();

    return () => {
      alive = false;
      disconnectAll();
    };
  }, [token]);

  function request() {
    if (!socket.current?.connected) return;

    setError('');
    socket.current.emit('viewer:request');
    setStatus('waiting');
  }

  function stop() {
    socket.current?.emit('viewer:stop');
    stopPeer();
    setError('You stopped watching.');
  }

  return (
    <div className="min-h-screen bg-slate-950 text-white">
      <div className="mx-auto max-w-5xl px-4 py-8">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-sm text-slate-400">Private viewer</p>
            <h1 className="text-3xl font-black">Camera feed</h1>
          </div>

          <StatusBadge status={status} />
        </div>

        <div className="mt-8 aspect-video overflow-hidden rounded-3xl bg-black ring-1 ring-white/10">
          <video
            ref={video}
            playsInline
            autoPlay
            controls={false}
            className="h-full w-full object-contain"
          />
        </div>

        <div className="mt-6 flex flex-wrap gap-3">
          {status === 'off' && (
            <button
              disabled={!canRequest}
              onClick={request}
              className="rounded-xl bg-white px-5 py-3 font-bold text-slate-950 disabled:opacity-40"
            >
              Request access
            </button>
          )}

          {status === 'waiting' && (
            <button
              onClick={stop}
              className="rounded-xl bg-slate-700 px-5 py-3 font-bold"
            >
              Cancel request
            </button>
          )}

          {status === 'live' && (
            <button
              onClick={stop}
              className="rounded-xl bg-red-600 px-5 py-3 font-bold"
            >
              Stop watching
            </button>
          )}

          {status === 'error' && (
            <button
              onClick={request}
              disabled={!canRequest}
              className="rounded-xl bg-white px-5 py-3 font-bold text-slate-950 disabled:opacity-40"
            >
              Request again
            </button>
          )}
        </div>

        {error && (
          <div
            role="alert"
            className="mt-5 rounded-2xl bg-red-950 p-4 text-sm text-red-200"
          >
            {error}
          </div>
        )}

        <p className="mt-6 text-sm text-slate-400">
          Room: {roomId || 'validating…'} · This application does not
          request microphone access.
        </p>
      </div>
    </div>
  );
}
