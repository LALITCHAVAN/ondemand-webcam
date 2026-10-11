import { io, Socket } from 'socket.io-client';

const defaultSocketOrigin =
  import.meta.env.VITE_SOCKET_URL ??
  (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? 'http://localhost:3000'
    : window.location.origin);

export function createSocket(auth: Record<string, string>): Socket {
  return io(defaultSocketOrigin, {
    withCredentials: true,
    auth,
    transports: ['websocket', 'polling'],
  });
}
