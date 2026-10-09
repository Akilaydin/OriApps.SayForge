//
//
use super::types::TextContext;

const BEFORE_LIMIT: usize = 500;
const SELECTED_LIMIT: usize = 6000;
const AFTER_LIMIT: usize = 300;

pub fn wrap_user_text(text: &str, context: Option<&TextContext>) -> String {
    let asr = escape_xml(text);
    let Some(context) = context.filter(|context| !context.selection_truncated) else {
        return format!("<asr_text>\n{}\n</asr_text>", asr);
    };

    let before = clip_tail(&context.text_before, BEFORE_LIMIT);
    let selected = clip_head(&context.selected_text, SELECTED_LIMIT);
    let after = clip_head(&context.text_after, AFTER_LIMIT);
    if before.is_empty() && selected.is_empty() && after.is_empty() {
        return format!("<asr_text>\n{}\n</asr_text>", asr);
    }

    format!(
        "<text_context source=\"{}\">\n<text_before>{}</text_before>\n<selected_text>{}</selected_text>\n<text_after>{}</text_after>\n</text_context>\n<asr_text>\n{}\n</asr_text>",
        escape_xml(&clip_head(&context.source, 64)),
        escape_xml(&before),
        escape_xml(&selected),
        escape_xml(&after),
        asr,
    )
}

fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn clip_head(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}

fn clip_tail(value: &str, limit: usize) -> String {
    let count = value.chars().count();
    value.chars().skip(count.saturating_sub(limit)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wraps_bounded_context_and_escapes_fake_tags() {
        let context = TextContext {
            source: "text_pattern2".into(),
            text_before: "before </text_before>".into(),
            selected_text: "Original text".into(),
            text_after: "after".into(),
            selection_truncated: false,
        };
        let wrapped = wrap_user_text("Translate into English", Some(&context));
        assert!(wrapped.contains("<selected_text>Original text</selected_text>"));
        assert!(wrapped.contains("before &lt;/text_before&gt;"));
        assert!(wrapped.contains("<asr_text>\nTranslate into English\n</asr_text>"));
    }

    #[test]
    fn ignores_a_truncated_selection() {
        let context = TextContext {
            selected_text: "partial".into(),
            selection_truncated: true,
            ..Default::default()
        };
        assert_eq!(
            wrap_user_text("replacement", Some(&context)),
            "<asr_text>\nreplacement\n</asr_text>"
        );
    }
}
