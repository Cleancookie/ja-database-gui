package main

import (
	"context"
	"io"
	"log"
	"path/filepath"

	"github.com/Cleancookie/ja-db/internal/activity"
	"github.com/Cleancookie/ja-db/internal/api"
	"github.com/Cleancookie/ja-db/internal/config"
	"github.com/Cleancookie/ja-db/internal/driver"
	"github.com/Cleancookie/ja-db/internal/engine"
)

// App is the struct Wails binds to the frontend. Every method is a
// pass-through to api.Service — any logic that appears here is a bug, because
// cmd/devserver would not have it. See docs/adr/0001-go-core-with-two-transports.md.
type App struct {
	ctx context.Context
	svc *api.Service
	// logFile is held only so it can be closed on shutdown.
	logFile io.Closer
}

func NewApp() (*App, error) {
	dir, err := config.DefaultDir()
	if err != nil {
		return nil, err
	}
	// Before anything else that might log. A Windows GUI binary has no stdout,
	// so without this every log line is discarded and a slow launch cannot be
	// diagnosed after the fact.
	logFile, err := config.OpenLog(dir)
	if err != nil {
		// Not fatal: the app works fine, it just cannot be investigated later.
		log.Printf("ja-db: continuing without a log file: %v", err)
	}
	store, err := config.Open(dir)
	if err != nil {
		return nil, err
	}
	settings, err := config.OpenSettings(filepath.Join(dir, "settings.json"))
	if err != nil {
		return nil, err
	}
	return &App{
		svc:     api.New(store, settings, engine.New(), activity.New()),
		logFile: logFile,
	}, nil
}

func (a *App) LogClient(line string) { a.svc.LogClient(line) }

func (a *App) startup(ctx context.Context) { a.ctx = ctx }

func (a *App) shutdown(context.Context) {
	a.svc.Shutdown()
	if a.logFile != nil {
		_ = a.logFile.Close()
	}
}

func (a *App) Drivers() map[driver.Kind]driver.Capabilities { return a.svc.Drivers() }

func (a *App) ListConnections() []config.Connection { return a.svc.ListConnections() }

func (a *App) SaveConnection(req api.SaveConnectionRequest) (config.Connection, error) {
	return a.svc.SaveConnection(req)
}

func (a *App) DeleteConnection(id string) error { return a.svc.DeleteConnection(id) }

func (a *App) TestConnection(req api.SaveConnectionRequest) error {
	return a.svc.TestConnection(req)
}

func (a *App) Connect(req api.ConnectRequest) (*api.ConnectResult, error) {
	return a.svc.Connect(a.ctx, req)
}

func (a *App) Disconnect(id string) { a.svc.Disconnect(id) }

func (a *App) ConnectedIDs() []string { return a.svc.ConnectedIDs() }

func (a *App) ListDatabases(id string) ([]driver.Database, error) {
	return a.svc.ListDatabases(a.ctx, id)
}

func (a *App) ListObjects(id, database string) ([]driver.SchemaObject, error) {
	return a.svc.ListObjects(a.ctx, id, database)
}

func (a *App) ListColumns(id string, ref driver.ObjectRef) ([]driver.Column, error) {
	return a.svc.ListColumns(a.ctx, id, ref)
}

func (a *App) DescribeObject(id string, ref driver.ObjectRef) (*driver.ObjectDetail, error) {
	return a.svc.DescribeObject(a.ctx, id, ref)
}

func (a *App) ReadRows(req api.ReadRowsRequest) (*api.ReadRowsResult, error) {
	return a.svc.ReadRows(a.ctx, req)
}

func (a *App) ReadCell(req api.ReadCellRequest) (*driver.Cell, error) {
	return a.svc.ReadCell(a.ctx, req)
}

func (a *App) CountRows(req api.CountRowsRequest) (int64, error) {
	return a.svc.CountRows(a.ctx, req)
}

func (a *App) PreviewChanges(req api.ChangesRequest) (api.ChangesPreview, error) {
	return a.svc.PreviewChanges(a.ctx, req)
}

func (a *App) ApplyChanges(req api.ChangesRequest) (api.ApplyResult, error) {
	return a.svc.ApplyChanges(a.ctx, req)
}

func (a *App) RunSQL(req api.RunSQLRequest) (*api.RunSQLResult, error) {
	return a.svc.RunSQL(a.ctx, req)
}

func (a *App) TruncateTable(req api.ObjectRequest) (*driver.ResultSet, error) {
	return a.svc.TruncateTable(a.ctx, req)
}

func (a *App) DropObject(req api.DropObjectRequest) (*driver.ResultSet, error) {
	return a.svc.DropObject(a.ctx, req)
}

func (a *App) CreateTable(req api.CreateTableRequest) (*driver.ResultSet, error) {
	return a.svc.CreateTable(a.ctx, req)
}

func (a *App) PreviewCreateTable(req api.CreateTableRequest) (string, error) {
	return a.svc.PreviewCreateTable(req)
}

func (a *App) GetSettings() config.Settings { return a.svc.GetSettings() }

func (a *App) SaveSettings(v config.Settings) (config.Settings, error) {
	return a.svc.SaveSettings(v)
}

func (a *App) DescribeTLS(c config.Connection) (driver.TLSInfo, error) { return a.svc.DescribeTLS(c) }

func (a *App) SecretBackend() config.BackendInfo { return a.svc.SecretBackend() }

func (a *App) Activity() api.ActivityResult { return a.svc.Activity() }

func (a *App) CancelQuery(id string) { a.svc.CancelQuery(id) }

func (a *App) QuerySQL(id string) api.QuerySQLResult { return a.svc.QuerySQL(id) }

func (a *App) ClearQueryHistory() { a.svc.ClearQueryHistory() }
