package server

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

var ErrServerClosed = errors.New("sidecar server closed")

type request struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      any             `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

type response struct {
	JSONRPC string         `json:"jsonrpc"`
	ID      any            `json:"id,omitempty"`
	Result  any            `json:"result,omitempty"`
	Error   *responseError `json:"error,omitempty"`
}

type responseError struct {
	Message string `json:"message"`
}

func Listen() (net.Listener, string, func(), error) {
	if runtime.GOOS == "windows" {
		listener, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			return nil, "", nil, err
		}
		return listener, "tcp:" + listener.Addr().String(), func() {
			_ = listener.Close()
		}, nil
	}

	dir, err := os.MkdirTemp("", "libravdb-sidecar-*")
	if err != nil {
		return nil, "", nil, err
	}
	path := filepath.Join(dir, "rpc.sock")
	listener, err := net.Listen("unix", path)
	if err != nil {
		_ = os.RemoveAll(dir)
		return nil, "", nil, err
	}
	return listener, path, func() {
		_ = listener.Close()
		_ = os.Remove(path)
		_ = os.RemoveAll(dir)
	}, nil
}

func Serve(ctx context.Context, listener net.Listener, srv *Server) error {
	if listener == nil {
		return errors.New("listener is required")
	}
	if srv == nil {
		return errors.New("server is required")
	}

	go func() {
		<-ctx.Done()
		_ = listener.Close()
	}()

	for {
		conn, err := listener.Accept()
		if err != nil {
			if ctx.Err() != nil || errors.Is(err, net.ErrClosed) {
				return ErrServerClosed
			}
			return err
		}
		go serveConn(ctx, conn, srv)
	}
}

func serveConn(ctx context.Context, conn net.Conn, srv *Server) {
	defer conn.Close()

	reader := bufio.NewReader(conn)
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		line, err := reader.ReadString('\n')
		if err != nil {
			if errors.Is(err, io.EOF) {
				return
			}
			return
		}

		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}

		var req request
		if err := json.Unmarshal([]byte(line), &req); err != nil {
			_ = writeResponse(conn, response{
				JSONRPC: "2.0",
				Error:   &responseError{Message: fmt.Sprintf("invalid request: %v", err)},
			})
			continue
		}

		var params any
		if len(req.Params) > 0 {
			if err := json.Unmarshal(req.Params, &params); err != nil {
				_ = writeResponse(conn, response{
					JSONRPC: "2.0",
					ID:      req.ID,
					Error:   &responseError{Message: fmt.Sprintf("invalid params: %v", err)},
				})
				continue
			}
		}

		result, err := srv.Call(ctx, req.Method, params)
		if err != nil {
			_ = writeResponse(conn, response{
				JSONRPC: "2.0",
				ID:      req.ID,
				Error:   &responseError{Message: err.Error()},
			})
			continue
		}

		_ = writeResponse(conn, response{
			JSONRPC: "2.0",
			ID:      req.ID,
			Result:  result,
		})
	}
}

func writeResponse(w io.Writer, resp response) error {
	data, err := json.Marshal(resp)
	if err != nil {
		return err
	}
	_, err = io.WriteString(w, string(data)+"\n")
	return err
}
