//
//
//
//
//
//
//
//
//
//
//

use serde::{Deserialize, Serialize};
use serde_json::Value;

///
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HotwordDelivery {
            Vocabulary,
            Context,
        Instruction,
                ProtocolHasNoSlot,
                NotWiredUp,
            UndecidedProtocol,
        UnknownProvider,
}

impl HotwordDelivery {
        ///
            pub fn reaches_asr(self) -> bool {
        matches!(
            self,
            HotwordDelivery::Vocabulary | HotwordDelivery::Context | HotwordDelivery::Instruction
        )
    }
}

///
///
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AsrHotwordCapability {
            pub buffered: HotwordDelivery,
        ///
                        pub buffered_client_cap: Option<usize>,
}

///
pub const ALL_ASR_PROVIDERS: &[&str] = &[
    "openai_compat",
    "openai_compat_transcribe",
    "openai_chat_audio",
    "openai_chat_audio_standard",
];

fn buffered_delivery(provider: &str, extra: &Value) -> HotwordDelivery {
    match provider {
        "openai_chat_audio" | "openai_chat_audio_standard" => HotwordDelivery::Instruction,
        "openai_compat_transcribe" => HotwordDelivery::NotWiredUp,
        "openai_compat" => match extra.get("protocol").and_then(Value::as_str) {
            Some("chat") | Some("chat_standard") => HotwordDelivery::Instruction,
            Some("transcriptions") => HotwordDelivery::NotWiredUp,
            _ => match super::asr_openai_compat::detected_protocol(extra) {
                Some(inner) => buffered_delivery(inner, extra),
                None => HotwordDelivery::UndecidedProtocol,
            },
        },
        _ => HotwordDelivery::UnknownProvider,
    }
}

pub fn hotword_capability(provider: &str, extra: &Value) -> AsrHotwordCapability {
    let buffered = buffered_delivery(provider, extra);
    AsrHotwordCapability {
        buffered,
        buffered_client_cap: None,
    }
}

///
#[tauri::command]
pub fn asr_hotword_capability(provider: String, extra: Option<Value>) -> AsrHotwordCapability {
    hotword_capability(&provider, &extra.unwrap_or(Value::Null))
}

///
///
///
///
///
#[tauri::command]
pub fn asr_hotword_capability_matrix() -> std::collections::HashMap<String, AsrHotwordCapability> {
    ALL_ASR_PROVIDERS
        .iter()
        .map(|provider| {
            (
                (*provider).to_string(),
                hotword_capability(provider, &Value::Null),
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn matrix_covers_exactly_the_native_dispatch_keys() {
        let matrix = asr_hotword_capability_matrix();
        let keys = super::super::registry::dispatch_keys_for_test();
        assert_eq!(matrix.len(), keys.len());
        for key in keys {
            let cap = matrix.get(key).expect("missing capability");
            assert_ne!(cap.buffered, HotwordDelivery::UnknownProvider);
            assert_eq!(cap.buffered_client_cap, None);
        }
    }

    #[test]
    fn protocol_determines_whether_hotwords_reach_asr() {
        for protocol in ["chat", "chat_standard"] {
            assert!(hotword_capability("openai_compat", &json!({"protocol": protocol})).buffered.reaches_asr());
        }
        assert!(!hotword_capability("openai_compat", &json!({"protocol": "transcriptions"})).buffered.reaches_asr());
        assert_eq!(hotword_capability("openai_compat", &Value::Null).buffered, HotwordDelivery::UndecidedProtocol);
        assert_eq!(hotword_capability("removed_vendor", &Value::Null).buffered, HotwordDelivery::UnknownProvider);
    }

    #[test]
    fn serializes_only_buffered_capabilities() {
        let value = serde_json::to_value(hotword_capability("openai_chat_audio", &Value::Null)).unwrap();
        assert_eq!(value, json!({
            "buffered": "instruction", "bufferedClientCap": null,
        }));
    }
}
