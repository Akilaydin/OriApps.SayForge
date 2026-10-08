use serde_json::{json, Map, Value};
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::commands::system::write_log_line;
use crate::context::{capture_foreground_monitor, MonitorBounds};

const OVERLAY_DEFAULT_BASE_WIDTH: f64 = 360.0;
const OVERLAY_BASE_HEIGHT: f64 = 64.0;
const OVERLAY_FALLBACK_WIDTH: f64 = 520.0;
const OVERLAY_FALLBACK_HEIGHT: f64 = 224.0;
///
///
///
const OVERLAY_FAILURE_WIDTH: f64 = 480.0;
const OVERLAY_FAILURE_HEIGHT: f64 = 176.0;
const OVERLAY_STREAMING_WIDTH: f64 = 480.0;
const OVERLAY_STREAMING_HEIGHT: f64 = 200.0;
const OVERLAY_MIC_HINT_WIDTH: f64 = 480.0;
const OVERLAY_MIC_HINT_HEIGHT: f64 = 104.0;
const OVERLAY_STREAMING_MIC_HINT_HEIGHT: f64 = 244.0;
const OVERLAY_SCREEN_MARGIN: f64 = 8.0;

const OVERLAY_ROOT_PADDING_BOTTOM: f64 = 16.0;

///
const OVERLAY_CSS_ZOOM_MIN: f64 = 0.5;
const OVERLAY_CSS_ZOOM_MAX: f64 = 4.0;
///
const HIDE_AFTER_BLANK_MS: u64 = 80;
const ACK_FIRST_TIMEOUT_MS: u64 = 1_200;
const ACK_SECOND_TIMEOUT_MS: u64 = 700;
const RECOVERY_ACK_TIMEOUT_MS: u64 = 2_000;

static LAST_PONG_MS: AtomicI64 = AtomicI64::new(0);
static SHOW_SEQ: AtomicU64 = AtomicU64::new(0);

pub fn record_overlay_pong(_seq: u64) {
    LAST_PONG_MS.store(now_ms(), Ordering::SeqCst);
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[derive(Debug, Clone, PartialEq)]
enum OverlayLayout {
    Base,
    BaseWithMicHint,
    Fallback,
        Failure,
        Streaming,
    StreamingWithMicHint,
}

impl OverlayLayout {
        ///
            fn is_interactive(&self) -> bool {
        matches!(self, OverlayLayout::Fallback | OverlayLayout::Failure)
    }

        ///
            fn dimensions(&self, base_width: f64) -> (f64, f64) {
        match self {
            OverlayLayout::Base => (base_width, OVERLAY_BASE_HEIGHT),
            OverlayLayout::BaseWithMicHint => (
                base_width.max(OVERLAY_MIC_HINT_WIDTH),
                OVERLAY_MIC_HINT_HEIGHT,
            ),
            OverlayLayout::Fallback => (OVERLAY_FALLBACK_WIDTH, OVERLAY_FALLBACK_HEIGHT),
            OverlayLayout::Failure => (OVERLAY_FAILURE_WIDTH, OVERLAY_FAILURE_HEIGHT),
            OverlayLayout::Streaming => (OVERLAY_STREAMING_WIDTH, OVERLAY_STREAMING_HEIGHT),
            OverlayLayout::StreamingWithMicHint => (
                OVERLAY_STREAMING_WIDTH,
                OVERLAY_STREAMING_MIC_HINT_HEIGHT,
            ),
        }
    }
}

pub struct WindowState {
    overlay_layout: Mutex<OverlayLayout>,
            last_applied_layout: Mutex<Option<OverlayLayout>>,
    overlay_base_width: Mutex<f64>,
            overlay_css_zoom: Mutex<f64>,
    overlay_monitor: Mutex<Option<MonitorBounds>>,
    overlay_lifecycle: Mutex<()>,
    latest_overlay_payload: Mutex<Option<Value>>,
    active_show_id: AtomicU64,
    active_generation: AtomicU64,
    show_started_at_ms: AtomicI64,
    last_ack_show_id: AtomicU64,
    last_ack_generation: AtomicU64,
    last_ack_at_ms: AtomicI64,
    recovery_started_show_id: AtomicU64,
    page_load_started_at_ms: AtomicI64,
    page_load_finished_at_ms: AtomicI64,
    renderer_ready_at_ms: AtomicI64,
        created_at: Instant,
}
impl WindowState {
    pub fn new() -> Self {
        Self {
            overlay_layout: Mutex::new(OverlayLayout::Base),
            last_applied_layout: Mutex::new(None),
            overlay_base_width: Mutex::new(OVERLAY_DEFAULT_BASE_WIDTH),
            overlay_css_zoom: Mutex::new(1.0),
            overlay_monitor: Mutex::new(None),
            overlay_lifecycle: Mutex::new(()),
            latest_overlay_payload: Mutex::new(None),
            active_show_id: AtomicU64::new(0),
            active_generation: AtomicU64::new(0),
            show_started_at_ms: AtomicI64::new(0),
            last_ack_show_id: AtomicU64::new(0),
            last_ack_generation: AtomicU64::new(0),
            last_ack_at_ms: AtomicI64::new(0),
            recovery_started_show_id: AtomicU64::new(0),
            page_load_started_at_ms: AtomicI64::new(0),
            page_load_finished_at_ms: AtomicI64::new(0),
            renderer_ready_at_ms: AtomicI64::new(0),
            created_at: Instant::now(),
        }
    }

        ///
            pub fn css_zoom(&self) -> f64 {
        *self.overlay_css_zoom.lock().unwrap()
    }

        ///
                ///
        fn note_css_zoom(&self, app: &AppHandle, device_pixel_ratio: Option<f64>) -> bool {
        let Some(dpr) = device_pixel_ratio.filter(|value| value.is_finite() && *value > 0.0) else {
            return false;
        };
        let monitor_scale = app
            .get_webview_window("overlay")
            .and_then(|overlay| overlay.scale_factor().ok())
            .or_else(|| app.primary_monitor().ok().flatten().map(|m| m.scale_factor()))
            .filter(|value| value.is_finite() && *value > 0.0)
            .unwrap_or(1.0);
        let zoom = (dpr / monitor_scale).clamp(OVERLAY_CSS_ZOOM_MIN, OVERLAY_CSS_ZOOM_MAX);

        let previous = {
            let mut cached = self.overlay_css_zoom.lock().unwrap();
            if (zoom - *cached).abs() < 0.01 {
                return false;
            }
            let previous = *cached;
            *cached = zoom;
            previous
        };

        write_log_line(&format!(
            "[overlay-scale] css zoom {:.4} -> {:.4} dpr={} monitor_scale={}",
            previous, zoom, dpr, monitor_scale,
        ));
        true
    }

        ///
                pub fn prewarm_overlay(&self, app: &AppHandle) {
        let _lifecycle_guard = self.overlay_lifecycle.lock().unwrap();
        if self.active_show_id.load(Ordering::SeqCst) != 0
            || app.get_webview_window("overlay").is_some()
        {
            return;
        }

        let layout = self.overlay_layout.lock().unwrap().clone();
        let base_width = *self.overlay_base_width.lock().unwrap();
        write_log_line("[overlay-health] idle prewarm begin");
        self.create_overlay(app, layout, base_width, false);
    }

        pub fn present_overlay(&self, app: &AppHandle, data: Value) -> u64 {
        self.apply_payload_layout(&data);
        self.capture_overlay_monitor();
        *self.latest_overlay_payload.lock().unwrap() = Some(data);

        let show_id = SHOW_SEQ.fetch_add(1, Ordering::SeqCst) + 1;
        self.active_show_id.store(show_id, Ordering::SeqCst);
        self.active_generation.store(0, Ordering::SeqCst);
        self.show_started_at_ms.store(now_ms(), Ordering::SeqCst);
        self.last_ack_show_id.store(0, Ordering::SeqCst);
        self.last_ack_generation.store(0, Ordering::SeqCst);
        self.last_ack_at_ms.store(0, Ordering::SeqCst);
        self.recovery_started_show_id.store(0, Ordering::SeqCst);

        let state_name = self.latest_state_name();
        let (gdi, user_obj) = gui_resource_counts();
        let overlay_visible = app.get_webview_window("overlay").and_then(|o| o.is_visible().ok());
        write_log_line(&format!(
            "[overlay-health] present show_id={} state={} generation=0 uptimeSec={} gdi={} user={} overlayVisible={:?}",
            show_id, state_name, self.created_at.elapsed().as_secs(), gdi, user_obj, overlay_visible,
        ));

        if self.ensure_visible(app, show_id) {
            self.emit_latest(app, true);
        }
        spawn_render_watchdog(app.clone(), show_id);
        spawn_topmost_keeper(app.clone(), show_id);
        show_id
    }

        pub fn show_overlay(&self, app: &AppHandle) -> u64 {
        let data = self.latest_overlay_payload.lock().unwrap().clone()
            .filter(|payload| payload.get("state").and_then(Value::as_str) != Some("blank"))
            .unwrap_or_else(|| json!({ "state": "waiting", "elapsedSec": 0 }));
        self.present_overlay(app, data)
    }

    pub fn hide_overlay(&self, app: &AppHandle) {
        self.active_show_id.store(0, Ordering::SeqCst);
        *self.overlay_monitor.lock().unwrap() = None;
        *self.last_applied_layout.lock().unwrap() = None;

        let prev_layout = {
            let mut layout = self.overlay_layout.lock().unwrap();
            let previous = layout.clone();
            *layout = OverlayLayout::Base;
            previous
        };

        if let Some(overlay) = app.get_webview_window("overlay") {
            set_overlay_interactivity(&overlay, false);

            //
            //
            //
            *self.latest_overlay_payload.lock().unwrap() = Some(json!({ "state": "blank" }));
            self.emit_latest(app, false);
            write_log_line(&format!(
                "[overlay-health] blank before hide prev_layout={:?} delay_ms={}",
                prev_layout, HIDE_AFTER_BLANK_MS,
            ));
            spawn_deferred_hide(app.clone(), prev_layout);
        }
    }

    pub fn update_overlay_state(&self, app: &AppHandle, data: &Value) {
        self.apply_payload_layout(data);
        *self.latest_overlay_payload.lock().unwrap() = Some(data.clone());

        if let Some(overlay) = app.get_webview_window("overlay") {
            let layout = self.overlay_layout.lock().unwrap().clone();
            let previous = self.last_applied_layout.lock().unwrap().clone();
            let changed = previous.as_ref() != Some(&layout);
            if changed {
                write_log_line(&format!(
                    "[overlay-layout] {:?} -> {:?} state={} streaming={} mic_hint={}",
                    previous,
                    layout,
                    data.get("state").and_then(Value::as_str).unwrap_or("unknown"),
                    data.get("streaming").and_then(Value::as_bool).unwrap_or(false),
                    data.get("micSourceLabel")
                        .and_then(Value::as_str)
                        .map(|s| !s.trim().is_empty())
                        .unwrap_or(false),
                ));
                let is_card = layout.is_interactive();
                self.apply_native_layout(app, &overlay, &layout);
                set_overlay_interactivity(&overlay, layout.is_interactive());
                if is_card {
                    let _ = overlay.show();
                }
            }
            self.emit_latest(app, false);
        }
    }

            pub fn overlay_ready(&self, app: &AppHandle, device_pixel_ratio: Option<f64>) {
        let show_id = self.active_show_id.load(Ordering::SeqCst);
        self.renderer_ready_at_ms.store(now_ms(), Ordering::SeqCst);
        self.note_css_zoom(app, device_pixel_ratio);
        if show_id == 0 {
            if let Some(overlay) = app.get_webview_window("overlay") {
                let _ = overlay.hide();
            }
            return;
        }

        write_log_line(&format!(
            "[overlay-health] renderer ready show_id={} generation={} diagnostic={}",
            show_id,
            self.active_generation.load(Ordering::SeqCst),
            compact_json(&self.diagnostic_snapshot(app)),
        ));
        if self.ensure_visible(app, show_id) {
            self.emit_latest(app, true);
        }
    }

    pub fn record_render_ack(&self, app: &AppHandle, data: &Value) {
        let show_id = data.get("showId").and_then(Value::as_u64).unwrap_or(0);
        let generation = data.get("generation").and_then(Value::as_u64).unwrap_or(0);
        let healthy = data.get("healthy").and_then(Value::as_bool).unwrap_or(false);
        let active_show_id = self.active_show_id.load(Ordering::SeqCst);
        let active_generation = self.active_generation.load(Ordering::SeqCst);

        if show_id != active_show_id || generation != active_generation {
            write_log_line(&format!(
                "[overlay-health] stale ack show_id={} generation={} active_show_id={} active_generation={}",
                show_id, generation, active_show_id, active_generation,
            ));
            return;
        }

        if self.note_css_zoom(app, data.get("devicePixelRatio").and_then(Value::as_f64)) {
            let layout = self.overlay_layout.lock().unwrap().clone();
            if let Some(overlay) = app.get_webview_window("overlay") {
                self.apply_native_layout(app, &overlay, &layout);
            }
        }
        self.warn_if_content_clipped(data, show_id);

        if !healthy {
            write_log_line(&format!(
                "[overlay-health] unhealthy render ack show_id={} generation={} detail={}",
                show_id, generation, compact_json(data),
            ));
            return;
        }

        self.last_ack_show_id.store(show_id, Ordering::SeqCst);
        self.last_ack_generation.store(generation, Ordering::SeqCst);
        self.last_ack_at_ms.store(now_ms(), Ordering::SeqCst);
        write_log_line(&format!(
            "[overlay-health] render ack OK show_id={} generation={} latency_ms={} state={} content={}x{} visibility={}",
            show_id,
            generation,
            self.ack_latency_ms(),
            data.get("overlayState").and_then(Value::as_str).unwrap_or("unknown"),
            data.get("contentWidth").and_then(Value::as_f64).unwrap_or(0.0),
            data.get("contentHeight").and_then(Value::as_f64).unwrap_or(0.0),
            data.get("documentVisibility").and_then(Value::as_str).unwrap_or("unknown"),
        ));
    }

        ///
                fn warn_if_content_clipped(&self, data: &Value, show_id: u64) {
        let number = |key: &str| data.get(key).and_then(Value::as_f64).unwrap_or(0.0);
        let clipped_top = number("clippedTop");
        let viewport_height = number("viewportHeight");
        let shortfall = if viewport_height > 0.0 {
            number("contentHeight") + OVERLAY_ROOT_PADDING_BOTTOM - viewport_height
        } else {
            0.0
        };
        if clipped_top <= 0.5 && shortfall <= 0.5 {
            return;
        }
        write_log_line(&format!(
            "[overlay-scale] content clipped show_id={} state={} clippedTopPx={:.2} shortfallPx={:.2} dpr={} cssZoom={:.4} viewport={}x{} content={}x{}",
            show_id,
            data.get("overlayState").and_then(Value::as_str).unwrap_or("unknown"),
            clipped_top,
            shortfall,
            number("devicePixelRatio"),
            self.css_zoom(),
            number("viewportWidth"),
            viewport_height,
            number("contentWidth"),
            number("contentHeight"),
        ));
    }

    pub fn health_snapshot(&self, app: &AppHandle, show_id: u64) -> Value {
        let active_show_id = self.active_show_id.load(Ordering::SeqCst);
        let active_generation = self.active_generation.load(Ordering::SeqCst);
        let ack_show_id = self.last_ack_show_id.load(Ordering::SeqCst);
        let ack_generation = self.last_ack_generation.load(Ordering::SeqCst);
        let recovery_started = self.recovery_started_show_id.load(Ordering::SeqCst) == show_id;
        let diagnostic = self.diagnostic_snapshot(app);
        json!({
            "showId": show_id,
            "activeShowId": active_show_id,
            "activeGeneration": active_generation,
            "acked": ack_show_id == show_id && ack_generation == active_generation,
            "ackGeneration": ack_generation,
            "ackLatencyMs": if ack_show_id == show_id { self.ack_latency_ms() } else { -1 },
            "recoveryStarted": recovery_started,
            "recoverySucceeded": recovery_started && ack_show_id == show_id && ack_generation > 0,
            "failureClass": self.failure_class(app),
            // Keep the existing frontend response contract; `diagnostic` adds detail.
            "window": overlay_window_snapshot(app),
            "diagnostic": diagnostic,
        })
    }

    fn reset_renderer_lifecycle(&self) {
        self.page_load_started_at_ms.store(0, Ordering::SeqCst);
        self.page_load_finished_at_ms.store(0, Ordering::SeqCst);
        self.renderer_ready_at_ms.store(0, Ordering::SeqCst);
    }

    fn record_page_load(&self, event: PageLoadEvent, url: &str) {
        let timestamp = now_ms();
        let event_name = match event {
            PageLoadEvent::Started => {
                self.page_load_started_at_ms.store(timestamp, Ordering::SeqCst);
                "started"
            }
            PageLoadEvent::Finished => {
                self.page_load_finished_at_ms.store(timestamp, Ordering::SeqCst);
                "finished"
            }
        };
        write_log_line(&format!(
            "[overlay-health] page load {} show_id={} generation={} url={}",
            event_name,
            self.active_show_id.load(Ordering::SeqCst),
            self.active_generation.load(Ordering::SeqCst),
            url,
        ));
    }

    fn diagnostic_snapshot(&self, app: &AppHandle) -> Value {
        let page_started_at = self.page_load_started_at_ms.load(Ordering::SeqCst);
        let page_finished_at = self.page_load_finished_at_ms.load(Ordering::SeqCst);
        let renderer_ready_at = self.renderer_ready_at_ms.load(Ordering::SeqCst);
        let current_ms = now_ms();
        json!({
            "window": overlay_window_snapshot(app),
            "pageLoadStarted": page_started_at > 0,
            "pageLoadFinished": page_finished_at > 0,
            "rendererReady": renderer_ready_at > 0,
            "pageLoadStartedAgeMs": event_age_ms(current_ms, page_started_at),
            "pageLoadFinishedAgeMs": event_age_ms(current_ms, page_finished_at),
            "rendererReadyAgeMs": event_age_ms(current_ms, renderer_ready_at),
        })
    }

    fn failure_class(&self, app: &AppHandle) -> &'static str {
        classify_overlay_failure(
            &overlay_window_snapshot(app),
            self.page_load_started_at_ms.load(Ordering::SeqCst) > 0,
            self.page_load_finished_at_ms.load(Ordering::SeqCst) > 0,
            self.renderer_ready_at_ms.load(Ordering::SeqCst) > 0,
        )
    }

    fn ack_latency_ms(&self) -> i64 {
        let ack_at = self.last_ack_at_ms.load(Ordering::SeqCst);
        let started_at = self.show_started_at_ms.load(Ordering::SeqCst);
        if ack_at <= 0 || started_at <= 0 { -1 } else { ack_at - started_at }
    }

    fn is_acked(&self, show_id: u64, generation: u64) -> bool {
        self.last_ack_show_id.load(Ordering::SeqCst) == show_id
            && self.last_ack_generation.load(Ordering::SeqCst) == generation
    }

        fn is_showing(&self, show_id: u64) -> bool {
        show_id != 0 && self.active_show_id.load(Ordering::SeqCst) == show_id
    }

            pub fn reassert_overlay_topmost_if_visible(&self, app: &AppHandle) {
        if self.active_show_id.load(Ordering::SeqCst) == 0 {
            return;
        }
        reassert_overlay_topmost(app);
    }

    fn is_active(&self, show_id: u64, generation: u64) -> bool {
        self.active_show_id.load(Ordering::SeqCst) == show_id
            && self.active_generation.load(Ordering::SeqCst) == generation
    }

    fn capture_overlay_monitor(&self) {
        let monitor = capture_foreground_monitor();
        if let Some(value) = &monitor {
            write_log_line(&format!(
                "[overlay-position] target_monitor source={} work=({},{},{},{})",
                value.source, value.left, value.top, value.right, value.bottom,
            ));
        }
        *self.overlay_monitor.lock().unwrap() = monitor;
    }

    fn apply_payload_layout(&self, data: &Value) {
        if let Some(width) = data.get("baseWidth").and_then(Value::as_f64) {
            if (160.0..=600.0).contains(&width) {
                *self.overlay_base_width.lock().unwrap() = width;
            }
        }

        let state = data.get("state").and_then(Value::as_str);
        let streaming_on = data.get("streaming").and_then(Value::as_bool).unwrap_or(false)
            || data
                .get("streamingText")
                .and_then(Value::as_str)
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false);
        let mic_hint_on = data
            .get("micSourceLabel")
            .and_then(Value::as_str)
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false);
        let candidate_layout = if state == Some("fallback") {
            OverlayLayout::Fallback
        } else if state == Some("failure") {
            OverlayLayout::Failure
        } else if state == Some("listening") && streaming_on && mic_hint_on {
            OverlayLayout::StreamingWithMicHint
        } else if state == Some("listening") && streaming_on {
            OverlayLayout::Streaming
        } else if matches!(state, Some("listening") | Some("thinking")) && mic_hint_on {
            OverlayLayout::BaseWithMicHint
        } else {
            OverlayLayout::Base
        };

        let mut current_layout = self.overlay_layout.lock().unwrap();
        let stable_visible_phase = matches!(
            state,
            Some("listening") | Some("thinking") | Some("toast") | Some("error")
        );
        let keep_expanded_bounds = stable_visible_phase
            && matches!(
                (&*current_layout, &candidate_layout),
                (OverlayLayout::BaseWithMicHint, OverlayLayout::Base)
                    | (OverlayLayout::StreamingWithMicHint, OverlayLayout::Streaming)
                    | (OverlayLayout::StreamingWithMicHint, OverlayLayout::BaseWithMicHint)
                    | (OverlayLayout::StreamingWithMicHint, OverlayLayout::Base)
                    | (OverlayLayout::Streaming, OverlayLayout::Base)
                    | (OverlayLayout::Streaming, OverlayLayout::BaseWithMicHint)
            );

        if !keep_expanded_bounds {
            *current_layout = candidate_layout;
        }
    }

    fn latest_state_name(&self) -> String {
        self.latest_overlay_payload.lock().unwrap().as_ref()
            .and_then(|payload| payload.get("state"))
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string()
    }

    fn payload_for_emit(&self, probe: bool) -> Option<Value> {
        let mut payload = self.latest_overlay_payload.lock().unwrap().clone()?;
        let show_id = self.active_show_id.load(Ordering::SeqCst);
        let generation = self.active_generation.load(Ordering::SeqCst);
        let object = payload.as_object_mut()?;
        object.insert("_overlayShowId".to_string(), json!(show_id));
        object.insert("_overlayGeneration".to_string(), json!(generation));
        object.insert("_overlayProbe".to_string(), json!(probe));
        Some(payload)
    }

    fn emit_latest(&self, app: &AppHandle, probe: bool) {
        let Some(overlay) = app.get_webview_window("overlay") else { return; };
        let Some(payload) = self.payload_for_emit(probe) else { return; };
        if let Err(error) = overlay.emit("overlay-state", payload) {
            write_log_line(&format!(
                "[overlay-health] emit FAILED show_id={} generation={} error={:?}",
                self.active_show_id.load(Ordering::SeqCst),
                self.active_generation.load(Ordering::SeqCst),
                error,
            ));
        }
    }

    fn ensure_visible(&self, app: &AppHandle, show_id: u64) -> bool {
        let _lifecycle_guard = self.overlay_lifecycle.lock().unwrap();
        let layout = self.overlay_layout.lock().unwrap().clone();
        let base_width = *self.overlay_base_width.lock().unwrap();

        let Some(overlay) = app.get_webview_window("overlay") else {
            write_log_line(&format!(
                "[overlay-health] handle missing show_id={} — creating",
                show_id,
            ));
            self.create_overlay(app, layout, base_width, true);
            return false;
        };

        let position_error = self.apply_native_layout(app, &overlay, &layout);
        let show_error = overlay.show().err().map(|error| format!("{:?}", error));
        let top_error = overlay.set_always_on_top(true).err().map(|error| format!("{:?}", error));
        reassert_overlay_topmost(app);
        set_overlay_interactivity(&overlay, layout.is_interactive());

        let snapshot = overlay_window_snapshot(app);
        if position_error.is_some() || show_error.is_some() || top_error.is_some() {
            write_log_line(&format!(
                "[overlay-health] native show FAILED show_id={} position_error={:?} show_error={:?} top_error={:?} snapshot={}",
                show_id, position_error, show_error, top_error, compact_json(&snapshot),
            ));
        } else {
            write_log_line(&format!(
                "[overlay-health] native show OK show_id={} snapshot={}",
                show_id, compact_json(&snapshot),
            ));
        }
        true
    }

    fn apply_native_layout(
        &self,
        app: &AppHandle,
        overlay: &tauri::WebviewWindow,
        layout: &OverlayLayout,
    ) -> Option<String> {
        *self.last_applied_layout.lock().unwrap() = Some(layout.clone());
        let base_width = *self.overlay_base_width.lock().unwrap();
        let css_zoom = self.css_zoom();
        let target_monitor = self.overlay_monitor.lock().unwrap().clone();
        if let Some(bounds) = target_monitor
            .as_ref()
            .and_then(|value| calc_monitor_overlay_bounds(app, value, layout, base_width, css_zoom))
        {
            let position_error = overlay.set_position(tauri::Position::Physical(
                tauri::PhysicalPosition::new(bounds.0, bounds.1),
            )).err();
            let size_error = overlay.set_size(tauri::Size::Physical(
                tauri::PhysicalSize::new(bounds.2, bounds.3),
            )).err();
            let _ = overlay.set_always_on_top(true);

            return match (position_error, size_error) {
                (None, None) => None,
                (position, size) => Some(format!("position={:?} size={:?}", position, size)),
            };
        }

        let bounds = calc_overlay_bounds(app, layout, base_width, css_zoom);
        let position_error = overlay.set_position(tauri::Position::Logical(
            tauri::LogicalPosition::new(bounds.0, bounds.1),
        )).err();
        let size_error = overlay.set_size(tauri::Size::Logical(
            tauri::LogicalSize::new(bounds.2, bounds.3),
        )).err();
        let _ = overlay.set_always_on_top(true);

        match (position_error, size_error) {
            (None, None) => None,
            (position, size) => Some(format!("position={:?} size={:?}", position, size)),
        }
    }

    fn recover_overlay(&self, app: &AppHandle, show_id: u64) {
        let _lifecycle_guard = self.overlay_lifecycle.lock().unwrap();
        if !self.is_active(show_id, 0) {
            return;
        }

        self.active_generation.store(1, Ordering::SeqCst);
        self.last_ack_show_id.store(0, Ordering::SeqCst);
        self.last_ack_generation.store(0, Ordering::SeqCst);
        self.recovery_started_show_id.store(show_id, Ordering::SeqCst);
        write_log_line(&format!(
            "[overlay-health] recovery begin show_id={} failure_class={} diagnostic={}",
            show_id,
            self.failure_class(app),
            compact_json(&self.diagnostic_snapshot(app)),
        ));

        if let Some(overlay) = app.get_webview_window("overlay") {
            if let Err(error) = overlay.destroy() {
                write_log_line(&format!(
                    "[overlay-health] destroy FAILED show_id={} error={:?}",
                    show_id, error,
                ));
            }
        }

        for _ in 0..20 {
            if app.get_webview_window("overlay").is_none() {
                break;
            }
            thread::sleep(Duration::from_millis(25));
        }

        if app.get_webview_window("overlay").is_some() {
            write_log_line(&format!(
                "[overlay-health] recovery FAILED show_id={} reason=stale_handle diagnostic={}",
                show_id,
                compact_json(&self.diagnostic_snapshot(app)),
            ));
            return;
        }

        let layout = self.overlay_layout.lock().unwrap().clone();
        let base_width = *self.overlay_base_width.lock().unwrap();
        self.create_overlay(app, layout, base_width, true);
    }

    fn create_overlay(
        &self,
        app: &AppHandle,
        layout: OverlayLayout,
        base_width: f64,
        show_immediately: bool,
    ) {
        self.reset_renderer_lifecycle();
        let bounds = calc_overlay_bounds(app, &layout, base_width, self.css_zoom());
        let builder = WebviewWindowBuilder::new(
            app,
            "overlay",
            WebviewUrl::App("overlay.html".into()),
        )
        .title("SayForge Overlay")
        .inner_size(bounds.2, bounds.3)
        .position(bounds.0, bounds.1)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .visible(false)
        .on_page_load(|window, payload| {
            let state = window.app_handle().state::<WindowState>();
            state.record_page_load(payload.event(), payload.url().as_str());
        });

        match builder.build() {
            Ok(overlay) => {
                let position_error = self.apply_native_layout(app, &overlay, &layout);
                set_overlay_interactivity(&overlay, layout.is_interactive());
                let show_error = if show_immediately {
                    overlay.show().err().map(|error| format!("{:?}", error))
                } else {
                    None
                };
                write_log_line(&format!(
                    "[overlay-health] create dispatched show_id={} generation={} prewarm={} initial_bounds={:?} position_error={:?} show_error={:?} shell_visible={} diagnostic={}",
                    self.active_show_id.load(Ordering::SeqCst),
                    self.active_generation.load(Ordering::SeqCst),
                    !show_immediately,
                    bounds,
                    position_error,
                    show_error,
                    overlay.is_visible().unwrap_or(false),
                    compact_json(&self.diagnostic_snapshot(app)),
                ));
            }
            Err(error) => {
                write_log_line(&format!(
                    "[overlay-health] create FAILED show_id={} generation={} bounds={:?} error={:?}",
                    self.active_show_id.load(Ordering::SeqCst),
                    self.active_generation.load(Ordering::SeqCst),
                    bounds,
                    error,
                ));
            }
        }
    }
}
///
///
#[cfg(windows)]
fn reassert_overlay_topmost(app: &AppHandle) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
    };

    let Some(overlay) = app.get_webview_window("overlay") else { return; };
    let hwnd_raw = match overlay.hwnd() {
        Ok(h) => h.0 as isize,
        Err(_) => return,
    };
    if hwnd_raw == 0 {
        return;
    }
    let hwnd = HWND(hwnd_raw as *mut _);
    unsafe {
        let _ = SetWindowPos(
            hwnd,
            HWND_TOPMOST,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
    }
}

#[cfg(not(windows))]
fn reassert_overlay_topmost(_app: &AppHandle) {}

fn spawn_topmost_keeper(app: AppHandle, show_id: u64) {
    let _ = thread::Builder::new()
        .name(format!("overlay-topmost-{}", show_id))
        .spawn(move || {
            let state = app.state::<WindowState>();
            reassert_overlay_topmost(&app);
            loop {
                thread::sleep(Duration::from_millis(400));
                if !state.is_showing(show_id) {
                    return;
                }
                reassert_overlay_topmost(&app);
            }
        });
}

///
fn spawn_deferred_hide(app: AppHandle, prev_layout: OverlayLayout) {
    let _ = thread::Builder::new()
        .name("overlay-deferred-hide".to_string())
        .spawn(move || {
            thread::sleep(Duration::from_millis(HIDE_AFTER_BLANK_MS));
            let state = app.state::<WindowState>();
            if state.active_show_id.load(Ordering::SeqCst) != 0 {
                write_log_line(
                    "[overlay-health] deferred hide skipped — a new present already started",
                );
                return;
            }
            let Some(overlay) = app.get_webview_window("overlay") else { return; };
            if let Err(error) = overlay.hide() {
                write_log_line(&format!(
                    "[overlay-diag] hide FAILED prev_layout={:?} hide_err={:?}",
                    prev_layout, error,
                ));
            }
        });
}

fn spawn_render_watchdog(app: AppHandle, show_id: u64) {
    let _ = thread::Builder::new()
        .name(format!("overlay-watchdog-{}", show_id))
        .spawn(move || {
            thread::sleep(Duration::from_millis(ACK_FIRST_TIMEOUT_MS));
            {
                let state = app.state::<WindowState>();
                if !state.is_active(show_id, 0) || state.is_acked(show_id, 0) {
                    return;
                }
                write_log_line(&format!(
                    "[overlay-health] ack timeout phase=1 show_id={} failure_class={} diagnostic={}",
                    show_id,
                    state.failure_class(&app),
                    compact_json(&state.diagnostic_snapshot(&app)),
                ));
                state.emit_latest(&app, true);
            }

            thread::sleep(Duration::from_millis(ACK_SECOND_TIMEOUT_MS));
            {
                let state = app.state::<WindowState>();
                if !state.is_active(show_id, 0) || state.is_acked(show_id, 0) {
                    return;
                }
                write_log_line(&format!(
                    "[overlay-health] ack timeout phase=2 show_id={} failure_class={} — confirmed unhealthy diagnostic={}",
                    show_id,
                    state.failure_class(&app),
                    compact_json(&state.diagnostic_snapshot(&app)),
                ));
                state.recover_overlay(&app, show_id);
            }

            thread::sleep(Duration::from_millis(RECOVERY_ACK_TIMEOUT_MS));
            let state = app.state::<WindowState>();
            if !state.is_active(show_id, 1) {
                return;
            }
            if state.is_acked(show_id, 1) {
                write_log_line(&format!(
                    "[overlay-health] recovery OK show_id={} latency_ms={} diagnostic={}",
                    show_id,
                    state.ack_latency_ms(),
                    compact_json(&state.diagnostic_snapshot(&app)),
                ));
            } else {
                write_log_line(&format!(
                    "[overlay-health] recovery FAILED show_id={} reason=no_render_ack failure_class={} diagnostic={}",
                    show_id,
                    state.failure_class(&app),
                    compact_json(&state.diagnostic_snapshot(&app)),
                ));
            }
        });
}

#[cfg(windows)]
fn gui_resource_counts() -> (u32, u32) {
    #[link(name = "user32")]
    extern "system" {
        fn GetGuiResources(hprocess: *mut core::ffi::c_void, uiflags: u32) -> u32;
    }
    let cur_proc = -1isize as *mut core::ffi::c_void;
    unsafe { (GetGuiResources(cur_proc, 0), GetGuiResources(cur_proc, 1)) }
}

#[cfg(not(windows))]
fn gui_resource_counts() -> (u32, u32) {
    (0, 0)
}

fn event_age_ms(current_ms: i64, event_ms: i64) -> i64 {
    if event_ms <= 0 {
        -1
    } else {
        current_ms.saturating_sub(event_ms)
    }
}

fn classify_overlay_failure(
    window: &Value,
    page_load_started: bool,
    page_load_finished: bool,
    renderer_ready: bool,
) -> &'static str {
    if window.get("handleExists").and_then(Value::as_bool) != Some(true) {
        return "handle_missing";
    }

    // Tauri can register a WebviewWindow label before wry asynchronously creates the
    // native WebView2 controller. A label with no readable position/size is therefore a
    // shell/phantom handle, not a successfully-created overlay.
    let native_window_ready = window.get("position").is_some_and(|value| !value.is_null())
        && window.get("size").is_some_and(|value| !value.is_null());
    if !native_window_ready {
        return "native_create_failed";
    }
    if !page_load_started {
        return "page_load_not_started";
    }
    if !page_load_finished {
        return "page_load_incomplete";
    }
    if !renderer_ready {
        return "renderer_not_ready";
    }

    let visible = window.get("visible").and_then(Value::as_bool) == Some(true);
    let on_screen = window
        .get("intersectsAnyMonitor")
        .and_then(Value::as_bool)
        == Some(true);
    if !visible || !on_screen {
        return "visibility_or_position";
    }

    "render_ack_missing"
}

fn compact_json(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "{}".to_string())
}

fn overlay_window_snapshot(app: &AppHandle) -> Value {
    let Some(overlay) = app.get_webview_window("overlay") else {
        return json!({ "handleExists": false });
    };

    let visible = overlay.is_visible().ok();
    let position = overlay.outer_position().ok();
    let size = overlay.outer_size().ok();
    let monitors = app.available_monitors().unwrap_or_default();
    let primary_monitor = app.primary_monitor().ok().flatten();

    let intersects_any = match (&position, &size) {
        (Some(position), Some(size)) => monitors.iter().any(|monitor| {
            let monitor_position = monitor.position();
            let monitor_size = monitor.size();
            let window_right = position.x as i64 + size.width as i64;
            let window_bottom = position.y as i64 + size.height as i64;
            let monitor_right = monitor_position.x as i64 + monitor_size.width as i64;
            let monitor_bottom = monitor_position.y as i64 + monitor_size.height as i64;
            window_right > monitor_position.x as i64
                && (position.x as i64) < monitor_right
                && window_bottom > monitor_position.y as i64
                && (position.y as i64) < monitor_bottom
        }),
        _ => false,
    };

    let mut snapshot = Map::new();
    snapshot.insert("handleExists".to_string(), json!(true));
    snapshot.insert("visible".to_string(), json!(visible));
    snapshot.insert("intersectsAnyMonitor".to_string(), json!(intersects_any));
    snapshot.insert(
        "position".to_string(),
        position.map(|value| json!({ "x": value.x, "y": value.y })).unwrap_or(Value::Null),
    );
    snapshot.insert(
        "size".to_string(),
        size.map(|value| json!({ "width": value.width, "height": value.height })).unwrap_or(Value::Null),
    );
    if let Some(monitor) = primary_monitor {
        let position = monitor.position();
        let size = monitor.size();
        snapshot.insert("primaryMonitor".to_string(), json!({
            "x": position.x,
            "y": position.y,
            "width": size.width,
            "height": size.height,
            "scaleFactor": monitor.scale_factor(),
        }));
    }
    Value::Object(snapshot)
}

fn set_overlay_interactivity(overlay: &tauri::WebviewWindow, interactive: bool) {
    let _ = overlay.set_ignore_cursor_events(!interactive);
}

#[cfg(test)]
mod tests {
    use super::{
        classify_overlay_failure, overlay_bounds_in_work_area, OverlayLayout, WindowState,
        OVERLAY_BASE_HEIGHT, OVERLAY_DEFAULT_BASE_WIDTH, OVERLAY_ROOT_PADDING_BOTTOM,
    };
    use serde_json::json;

        const WORK: (i64, i64, i64, i64) = (0, 0, 2560, 1318);
    const SCALE: f64 = 1.5;
        const TEXT_SCALE_123: f64 = 1.2285;
        const OVERLAY_PILL_MIN_HEIGHT: f64 = 38.0;

        fn required_css_height() -> f64 {
        OVERLAY_ROOT_PADDING_BOTTOM + OVERLAY_PILL_MIN_HEIGHT
    }

    #[test]
    fn base_window_fits_pill_at_default_scale() {
        let (_, _, _, height) = overlay_bounds_in_work_area(
            WORK,
            SCALE,
            OverlayLayout::Base.dimensions(OVERLAY_DEFAULT_BASE_WIDTH),
            1.0,
        );
        let css_height = height as f64 / SCALE;
        assert!(
            css_height >= required_css_height(),
            "base window {}px physical = {}css < required {}css",
            height,
            css_height,
            required_css_height(),
        );
    }

                #[test]
    fn base_window_still_fits_pill_when_os_text_scale_enlarges_css_px() {
        let (_, _, _, height) = overlay_bounds_in_work_area(
            WORK,
            SCALE,
            OverlayLayout::Base.dimensions(OVERLAY_DEFAULT_BASE_WIDTH),
            TEXT_SCALE_123,
        );
        let css_height = height as f64 / (SCALE * TEXT_SCALE_123);
        assert!(
            css_height >= required_css_height(),
            "scaled base window {}px physical = {}css < required {}css",
            height,
            css_height,
            required_css_height(),
        );
        assert!(
            height > (OVERLAY_BASE_HEIGHT * SCALE) as u32,
            "window did not grow with css_zoom: {}",
            height,
        );
    }

    #[test]
    fn every_layout_fits_its_content_under_os_text_scale() {
        let cases = [
            ("base", OverlayLayout::Base, required_css_height()),
            ("mic_hint", OverlayLayout::BaseWithMicHint, required_css_height() + 8.0 + 30.0),
            ("fallback", OverlayLayout::Fallback, OVERLAY_ROOT_PADDING_BOTTOM + 149.0),
            //
            ("failure", OverlayLayout::Failure, OVERLAY_ROOT_PADDING_BOTTOM + 146.0),
            ("streaming", OverlayLayout::Streaming, required_css_height() + 8.0 + 110.0),
            (
                "streaming_mic_hint",
                OverlayLayout::StreamingWithMicHint,
                required_css_height() + 8.0 + 110.0 + 8.0 + 30.0,
            ),
        ];
        for (name, layout, required) in cases {
            let (_, _, _, height) = overlay_bounds_in_work_area(
                WORK,
                SCALE,
                layout.dimensions(OVERLAY_DEFAULT_BASE_WIDTH),
                TEXT_SCALE_123,
            );
            let css_height = height as f64 / (SCALE * TEXT_SCALE_123);
            assert!(
                css_height >= required,
                "{}: {}css available < {}css required",
                name,
                css_height,
                required,
            );
        }
    }

            #[test]
    fn bottom_edge_stays_put_regardless_of_css_zoom() {
        let bottom_of = |css_zoom: f64| {
            let (_, y, _, height) = overlay_bounds_in_work_area(
                WORK,
                SCALE,
                OverlayLayout::Base.dimensions(OVERLAY_DEFAULT_BASE_WIDTH),
                css_zoom,
            );
            y as i64 + height as i64
        };
        assert_eq!(bottom_of(1.0), bottom_of(TEXT_SCALE_123));
        assert_eq!(bottom_of(1.0), bottom_of(2.25));
    }

        #[test]
    fn extreme_css_zoom_stays_inside_work_area() {
        let (x, y, width, height) = overlay_bounds_in_work_area(
            WORK,
            SCALE,
            OverlayLayout::StreamingWithMicHint.dimensions(OVERLAY_DEFAULT_BASE_WIDTH),
            4.0,
        );
        assert!(x >= 0, "x={}", x);
        assert!(y >= 0, "y={}", y);
        assert!(x as i64 + width as i64 <= 2560, "right={}", x as i64 + width as i64);
        assert!(y as i64 + height as i64 <= 1318, "bottom={}", y as i64 + height as i64);
    }

            fn layouts_after(payloads: &[serde_json::Value]) -> Vec<OverlayLayout> {
        let state = WindowState::new();
        payloads
            .iter()
            .map(|payload| {
                state.apply_payload_layout(payload);
                state.overlay_layout.lock().unwrap().clone()
            })
            .collect()
    }

        ///
                #[test]
    fn only_card_layouts_receive_mouse_clicks() {
        let expected = |layout: &OverlayLayout| match layout {
            OverlayLayout::Fallback | OverlayLayout::Failure => true,
            OverlayLayout::Base
            | OverlayLayout::BaseWithMicHint
            | OverlayLayout::Streaming
            | OverlayLayout::StreamingWithMicHint => false,
        };
        for layout in [
            OverlayLayout::Base,
            OverlayLayout::BaseWithMicHint,
            OverlayLayout::Fallback,
            OverlayLayout::Failure,
            OverlayLayout::Streaming,
            OverlayLayout::StreamingWithMicHint,
        ] {
            assert_eq!(
                layout.is_interactive(),
                expected(&layout),
                "interactivity drifted for {:?}",
                layout,
            );
        }
    }

        ///
                #[test]
    fn failure_state_gets_its_own_layout_even_after_a_mic_hint() {
        let layouts = layouts_after(&[
            json!({ "state": "listening", "micSourceLabel": "Blackwire 5220" }),
            json!({ "state": "failure", "failureTitle": "recognition failed" }),
        ]);
        assert_eq!(
            layouts,
            vec![OverlayLayout::BaseWithMicHint, OverlayLayout::Failure],
        );
    }

    #[test]
    fn streaming_flag_expands_the_window_while_listening() {
        assert_eq!(
            layouts_after(&[json!({ "state": "listening", "streaming": true })]),
            vec![OverlayLayout::Streaming],
        );
    }

        ///
                ///
            #[test]
    fn listening_update_without_streaming_flag_must_not_shrink_the_window() {
        let layouts = layouts_after(&[
            json!({ "state": "listening", "streaming": true }),
            json!({ "state": "listening", "warning": "volume is low", "warningTone": "warn" }),
            json!({ "state": "listening", "streaming": true }),
        ]);
        assert_eq!(
            layouts,
            vec![
                OverlayLayout::Streaming,
                OverlayLayout::Streaming,
                OverlayLayout::Streaming,
            ],
        );
    }

        #[test]
    fn streaming_window_survives_a_mic_hint_only_update() {
        let layouts = layouts_after(&[
            json!({ "state": "listening", "streaming": true }),
            json!({ "state": "listening", "micSourceLabel": "Blackwire 5220" }),
        ]);
        assert_eq!(
            layouts,
            vec![OverlayLayout::Streaming, OverlayLayout::Streaming],
        );
    }

            #[test]
    fn a_new_waiting_phase_resets_to_the_base_layout() {
        let layouts = layouts_after(&[
            json!({ "state": "listening", "streaming": true }),
            json!({ "state": "waiting", "elapsedSec": 0 }),
        ]);
        assert_eq!(layouts, vec![OverlayLayout::Streaming, OverlayLayout::Base]);
    }

    fn native_window() -> serde_json::Value {
        json!({
            "handleExists": true,
            "visible": true,
            "intersectsAnyMonitor": true,
            "position": { "x": 10, "y": 20 },
            "size": { "width": 200, "height": 56 }
        })
    }

    #[test]
    fn classifies_phantom_tauri_handle_as_native_create_failure() {
        let window = json!({
            "handleExists": true,
            "visible": null,
            "intersectsAnyMonitor": false,
            "position": null,
            "size": null
        });
        assert_eq!(
            classify_overlay_failure(&window, false, false, false),
            "native_create_failed"
        );
    }

    #[test]
    fn classifies_page_and_renderer_stages() {
        let window = native_window();
        assert_eq!(
            classify_overlay_failure(&window, false, false, false),
            "page_load_not_started"
        );
        assert_eq!(
            classify_overlay_failure(&window, true, false, false),
            "page_load_incomplete"
        );
        assert_eq!(
            classify_overlay_failure(&window, true, true, false),
            "renderer_not_ready"
        );
        assert_eq!(
            classify_overlay_failure(&window, true, true, true),
            "render_ack_missing"
        );
    }

    #[test]
    fn classifies_visible_but_offscreen_window() {
        let mut window = native_window();
        window["intersectsAnyMonitor"] = json!(false);
        assert_eq!(
            classify_overlay_failure(&window, true, true, true),
            "visibility_or_position"
        );
    }
}

fn monitor_info(app: &AppHandle) -> (f64, f64, f64) {
    if let Some(monitor) = app.primary_monitor().ok().flatten() {
        let size = monitor.size();
        let scale = monitor.scale_factor();
        (size.width as f64 / scale, size.height as f64 / scale, scale)
    } else {
        (1920.0, 1080.0, 1.0)
    }
}

fn calc_overlay_bounds(
    app: &AppHandle,
    layout: &OverlayLayout,
    base_width: f64,
    css_zoom: f64,
) -> (f64, f64, f64, f64) {
    let (design_width, design_height) = layout.dimensions(base_width);
    let desired_width = design_width * css_zoom;
    let desired_height = design_height * css_zoom;
    let (screen_width, screen_height, _) = monitor_info(app);
    let width = desired_width.min(screen_width - 40.0).max(160.0);
    let height = desired_height
        .min(screen_height - 40.0)
        .max(OVERLAY_BASE_HEIGHT * css_zoom);
    let x = ((screen_width - width) / 2.0).round();
    let y = (screen_height - height - 72.0).max(8.0);
    (x, y, width, height)
}

///
fn overlay_bounds_in_work_area(
    work: (i64, i64, i64, i64),
    scale: f64,
    design: (f64, f64),
    css_zoom: f64,
) -> (i32, i32, u32, u32) {
    let (left, top, right, bottom) = work;
    let work_width = (right - left).max(1);
    let work_height = (bottom - top).max(1);
    let margin = (OVERLAY_SCREEN_MARGIN * scale).round().max(1.0) as i64;
    let bottom_gap = (72.0 * scale).round().max(margin as f64) as i64;
    let available_width = (work_width - margin * 2).max(1);
    let available_height = (work_height - margin * 2).max(1);
    let width = ((design.0 * css_zoom * scale).ceil().max(1.0) as i64).min(available_width);
    let height = ((design.1 * css_zoom * scale).ceil().max(1.0) as i64).min(available_height);
    let x = left + ((work_width - width) / 2);
    let min_y = top + margin;
    let max_y = bottom - margin - height;
    let y = (bottom - bottom_gap - height).clamp(min_y, max_y);
    (x as i32, y as i32, width as u32, height as u32)
}

fn calc_monitor_overlay_bounds(
    app: &AppHandle,
    target: &MonitorBounds,
    layout: &OverlayLayout,
    base_width: f64,
    css_zoom: f64,
) -> Option<(i32, i32, u32, u32)> {
    let center_x = target.left as i64 + (target.right as i64 - target.left as i64) / 2;
    let center_y = target.top as i64 + (target.bottom as i64 - target.top as i64) / 2;
    let monitors = app.available_monitors().ok()?;
    let monitor = monitors.iter().find(|monitor| {
        let position = monitor.position();
        let size = monitor.size();
        center_x >= position.x as i64
            && center_x < position.x as i64 + size.width as i64
            && center_y >= position.y as i64
            && center_y < position.y as i64 + size.height as i64
    })?;

    let scale = monitor.scale_factor();
    if !scale.is_finite() || scale <= 0.0 {
        return None;
    }

    Some(overlay_bounds_in_work_area(
        (
            target.left as i64,
            target.top as i64,
            target.right as i64,
            target.bottom as i64,
        ),
        scale,
        layout.dimensions(base_width),
        css_zoom,
    ))
}
