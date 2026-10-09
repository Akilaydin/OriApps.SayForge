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
            pub streaming: HotwordDelivery,
            pub buffered: HotwordDelivery,
        pub has_streaming_path: bool,
        ///
                    pub streaming_client_cap: Option<usize>,
        ///
                        pub buffered_client_cap: Option<usize>,
}

///
pub const ALL_ASR_PROVIDERS: &[&str] = &[
    "groq_whisper",
    "openai_transcribe",
    "openai_live_transcribe",
    "openai_compat",
    "openai_compat_transcribe",
    "openai_chat_audio",
    "openai_chat_audio_standard",
    "gemini_transcribe",
    "gemini_live_transcribe",
    "openrouter_transcribe",
];

///
const OPENAI_KEYWORD_CAP: usize = 100;
///
const GEMINI_PROMPT_CAP: usize = 100;

///
fn buffered_delivery(provider: &str, extra: &Value) -> HotwordDelivery {
    match provider {
        "openai_chat_audio" | "openai_chat_audio_standard" => HotwordDelivery::Instruction,
        "gemini_transcribe" | "gemini_live_transcribe" => HotwordDelivery::Instruction,
        "groq_whisper" | "openai_transcribe" | "openai_compat_transcribe" => {
            HotwordDelivery::NotWiredUp
        }
        "openai_live_transcribe" => HotwordDelivery::NotWiredUp,
        "openrouter_transcribe" => HotwordDelivery::ProtocolHasNoSlot,
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

///
fn streaming_delivery(provider: &str) -> Option<HotwordDelivery> {
    match provider {
        "openai_live_transcribe" => Some(HotwordDelivery::Vocabulary),
        //
        "gemini_live_transcribe" => Some(HotwordDelivery::ProtocolHasNoSlot),
        _ => None,
    }
}

///
fn client_cap(provider: &str, path_delivery: HotwordDelivery) -> Option<usize> {
    if !path_delivery.reaches_asr() {
        return None;
    }
    match provider {
        "openai_live_transcribe" => Some(OPENAI_KEYWORD_CAP),
        "gemini_transcribe" | "gemini_live_transcribe" => Some(GEMINI_PROMPT_CAP),
        _ => None,
    }
}

///
pub fn hotword_capability(provider: &str, extra: &Value) -> AsrHotwordCapability {
    let buffered = buffered_delivery(provider, extra);
    let declared_streaming = streaming_delivery(provider);
    let streaming = declared_streaming.unwrap_or(buffered);
    AsrHotwordCapability {
        streaming_client_cap: client_cap(provider, streaming),
        buffered_client_cap: client_cap(provider, buffered),
        streaming,
        buffered,
        has_streaming_path: declared_streaming.is_some(),
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

    fn cap(provider: &str) -> AsrHotwordCapability {
        hotword_capability(provider, &Value::Null)
    }

        ///
                    #[test]
    fn every_dispatch_key_declares_its_hotword_behaviour() {
        for provider in ALL_ASR_PROVIDERS {
            let c = cap(provider);
            assert_ne!(
                c.buffered,
                HotwordDelivery::UnknownProvider,
                "{} 没有声明一次性路径的热词行为",
                provider,
            );
            assert_ne!(
                c.streaming,
                HotwordDelivery::UnknownProvider,
                "{} 没有声明流式路径的热词行为",
                provider,
            );
        }
    }

        ///
            #[test]
    fn an_unknown_provider_is_not_silently_reported_as_unsupported() {
        let unknown = cap("some_provider_we_never_heard_of");
        assert_eq!(unknown.buffered, HotwordDelivery::UnknownProvider);
        assert_ne!(unknown.buffered, HotwordDelivery::NotWiredUp);
        assert_ne!(unknown.buffered, HotwordDelivery::ProtocolHasNoSlot);
        assert!(!unknown.buffered.reaches_asr());
    }

        #[test]
    fn the_multipart_transcriptions_path_does_not_carry_hotwords() {
        for provider in [
            "groq_whisper",
            "openai_transcribe",
            "openai_compat_transcribe",
        ] {
            let c = cap(provider);
            assert_eq!(c.buffered, HotwordDelivery::NotWiredUp, "{}", provider);
            assert!(!c.buffered.reaches_asr(), "{}", provider);
        }
    }

        ///
            #[test]
    fn the_two_live_providers_are_inverted_between_paths() {
        let openai = cap("openai_live_transcribe");
        assert_eq!(openai.streaming, HotwordDelivery::Vocabulary);
        assert_eq!(openai.buffered, HotwordDelivery::NotWiredUp);
        assert!(openai.streaming.reaches_asr() && !openai.buffered.reaches_asr());

        let gemini = cap("gemini_live_transcribe");
        assert_eq!(gemini.streaming, HotwordDelivery::ProtocolHasNoSlot);
        assert_eq!(gemini.buffered, HotwordDelivery::Instruction);
        assert!(!gemini.streaming.reaches_asr() && gemini.buffered.reaches_asr());
    }

        #[test]
    fn providers_without_a_streaming_path_report_the_same_answer_twice() {
        for provider in ["groq_whisper", "openrouter_transcribe"] {
            let c = cap(provider);
            assert!(!c.has_streaming_path, "{}", provider);
            assert_eq!(c.streaming, c.buffered, "{}", provider);
        }
    }

        #[test]
    fn a_missing_protocol_slot_is_distinct_from_an_unwired_one() {
        assert_eq!(
            cap("openrouter_transcribe").buffered,
            HotwordDelivery::ProtocolHasNoSlot,
        );
        assert_eq!(
            cap("openai_transcribe").buffered,
            HotwordDelivery::NotWiredUp,
        );
    }

        #[test]
    fn the_compat_card_follows_the_protocol_setting() {
        let auto = hotword_capability("openai_compat", &json!({ "protocol": "auto" }));
        assert_eq!(auto.buffered, HotwordDelivery::UndecidedProtocol);
        assert!(!auto.buffered.reaches_asr());
        assert_eq!(
            hotword_capability("openai_compat", &Value::Null).buffered,
            HotwordDelivery::UndecidedProtocol,
        );

        assert_eq!(
            hotword_capability("openai_compat", &json!({ "protocol": "chat" })).buffered,
            HotwordDelivery::Instruction,
        );
        assert_eq!(
            hotword_capability("openai_compat", &json!({ "protocol": "chat_standard" })).buffered,
            HotwordDelivery::Instruction,
        );
        assert_eq!(
            hotword_capability("openai_compat", &json!({ "protocol": "transcriptions" })).buffered,
            HotwordDelivery::NotWiredUp,
        );
    }

        #[test]
    fn the_client_cap_is_only_reported_where_it_actually_applies() {
        assert_eq!(cap("groq_whisper").buffered_client_cap, None);
        assert_eq!(cap("openrouter_transcribe").buffered_client_cap, None);
    }

        ///
                #[test]
    fn the_cap_follows_the_execution_path_not_the_provider() {
        let openai = cap("openai_live_transcribe");
        assert_eq!(openai.streaming_client_cap, Some(100));
        assert_eq!(
            openai.buffered_client_cap, None,
            "回落路径一条热词都不发，却报了发送上限",
        );

        let gemini_live = cap("gemini_live_transcribe");
        assert_eq!(
            gemini_live.streaming_client_cap, None,
            "Live API 没有热词字段，却报了发送上限",
        );
        assert_eq!(gemini_live.buffered_client_cap, Some(100));
    }

        ///
                #[test]
    fn gemini_file_transcription_declares_its_truncation() {
        let gemini = cap("gemini_transcribe");
        assert_eq!(gemini.buffered, HotwordDelivery::Instruction);
        assert_eq!(gemini.buffered_client_cap, Some(100));
        assert!(!gemini.has_streaming_path);
        assert_eq!(gemini.streaming_client_cap, gemini.buffered_client_cap);
    }

        ///
            #[test]
    fn no_path_reports_a_cap_without_actually_sending_hotwords() {
        for provider in ALL_ASR_PROVIDERS {
            let c = cap(provider);
            if !c.streaming.reaches_asr() {
                assert_eq!(
                    c.streaming_client_cap, None,
                    "{} 的流式路径不发热词，却报了发送上限",
                    provider,
                );
            }
            if !c.buffered.reaches_asr() {
                assert_eq!(
                    c.buffered_client_cap, None,
                    "{} 的一次性路径不发热词，却报了发送上限",
                    provider,
                );
            }
        }
    }

        ///
            #[test]
    fn the_documented_caps_match_the_request_builders() {
        assert_eq!(
            OPENAI_KEYWORD_CAP,
            crate::providers::asr_openai_realtime::keyword_limit_for_docs(),
        );
        assert_eq!(
            GEMINI_PROMPT_CAP,
            crate::providers::asr_gemini::hotword_limit_for_docs(),
        );
    }

        ///
                ///
                #[test]
    fn the_declaration_list_matches_the_dispatch_table() {
        let mut declared: Vec<&str> = ALL_ASR_PROVIDERS.to_vec();
        let mut dispatched: Vec<&str> = crate::providers::registry::dispatch_keys_for_test();
        declared.sort_unstable();
        dispatched.sort_unstable();
        assert_eq!(
            declared, dispatched,
            "capabilities.rs 的声明清单和 registry.rs 的分发 key 不一致",
        );
    }

        #[test]
    fn it_serializes_in_the_shape_the_frontend_expects() {
        let json = serde_json::to_value(cap("openai_live_transcribe")).unwrap();
        assert_eq!(json["streaming"], "vocabulary");
        assert_eq!(json["buffered"], "not_wired_up");
        assert_eq!(json["hasStreamingPath"], true);
        assert_eq!(json["streamingClientCap"], 100);
        assert_eq!(json["bufferedClientCap"], Value::Null);

        let groq = serde_json::to_value(cap("groq_whisper")).unwrap();
        assert_eq!(groq["buffered"], "not_wired_up");
        assert_eq!(groq["bufferedClientCap"], Value::Null);

        let openai = serde_json::to_value(cap("openai_live_transcribe")).unwrap();
        assert_eq!(openai["streamingClientCap"], 100);
        assert_eq!(openai["bufferedClientCap"], Value::Null);
    }

        ///
                #[test]
    fn the_reference_matrix_covers_every_provider() {
        let matrix = asr_hotword_capability_matrix();
        assert_eq!(matrix.len(), ALL_ASR_PROVIDERS.len());
        for provider in ALL_ASR_PROVIDERS {
            let row = matrix
                .get(*provider)
                .unwrap_or_else(|| panic!("对照表缺了 {}", provider));
            assert_ne!(row.buffered, HotwordDelivery::UnknownProvider, "{}", provider);
            assert_ne!(row.streaming, HotwordDelivery::UnknownProvider, "{}", provider);
        }
    }

        ///
                #[test]
    fn the_matrix_leaves_the_compat_card_undecided() {
        let matrix = asr_hotword_capability_matrix();
        assert_eq!(
            matrix["openai_compat"].buffered,
            HotwordDelivery::UndecidedProtocol,
        );
    }
}
