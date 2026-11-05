// The server-only package is a build-time boundary marker. Vitest runs the
// server authorization helpers in Node, where the marker has no runtime work.
export {};
