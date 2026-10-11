import axios from 'axios';

const defaultApiBase =
  import.meta.env.VITE_API_URL ??
  (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? 'http://localhost:3000'
    : window.location.origin);

export const api = axios.create({
  baseURL: defaultApiBase,
  withCredentials: true,
});
