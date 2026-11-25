//! One parser for the three model spellings the app exchanges.
//!
//! * picker / session: `gateway:<gatewayId>:<modelId>` (components URI-encoded)
//! * Codex -> Router:  `<gatewayId>/<modelId>` (raw components)
//! * native ChatGPT:   `<modelId>`
//!
//! The Router must never infer "native" from a provider-qualified value that lost its slash.
//! Parsing lives here so the dispatch rule and its tests describe the same contract as
//! `src/lib/model-identity.ts`.

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ModelIdentity {
    Native { model: String },
    Gateway { gateway_id: String, model_id: String, route: String },
    Invalid(String),
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%'
            && index + 2 < bytes.len()
            && let (Some(high), Some(low)) = (hex(bytes[index + 1]), hex(bytes[index + 2]))
        {
            decoded.push(high * 16 + low);
            index += 3;
            continue;
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

fn hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

impl ModelIdentity {
    pub(crate) fn parse(raw: &str) -> Self {
        let value = raw.trim();
        if value.is_empty() {
            return Self::Invalid(value.to_string());
        }
        if let Some(rest) = value.strip_prefix("gateway:") {
            let Some((gateway, model)) = rest.split_once(':') else {
                return Self::Invalid(value.to_string());
            };
            if gateway.is_empty() || model.is_empty() {
                return Self::Invalid(value.to_string());
            }
            let gateway_id = percent_decode(gateway);
            let model_id = percent_decode(model);
            return Self::Gateway { route: format!("{gateway_id}/{model_id}"), gateway_id, model_id };
        }
        if let Some((gateway, model)) = value.split_once('/')
            && !gateway.is_empty()
            && !model.is_empty()
        {
            return Self::Gateway {
                route: value.to_string(),
                gateway_id: gateway.to_string(),
                model_id: model.to_string(),
            };
        }
        Self::Native { model: value.to_string() }
    }

    #[allow(dead_code)] // Used by the parser's unit tests and kept as the dispatch contract.
    pub(crate) fn route_target(&self) -> Option<(&str, &str)> {
        match self {
            Self::Gateway { gateway_id, model_id, .. } => Some((gateway_id, model_id)),
            Self::Native { .. } | Self::Invalid(_) => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::ModelIdentity;

    #[test]
    fn parses_all_three_spellings() {
        assert_eq!(
            ModelIdentity::parse("gateway:deepseek:deepseek-V4.1-flash"),
            ModelIdentity::Gateway {
                gateway_id: "deepseek".into(),
                model_id: "deepseek-V4.1-flash".into(),
                route: "deepseek/deepseek-V4.1-flash".into(),
            }
        );
        assert_eq!(
            ModelIdentity::parse("deepseek/deepseek-V4.1-flash"),
            ModelIdentity::Gateway {
                gateway_id: "deepseek".into(),
                model_id: "deepseek-V4.1-flash".into(),
                route: "deepseek/deepseek-V4.1-flash".into(),
            }
        );
        assert_eq!(ModelIdentity::parse("gpt-6.2-sol"), ModelIdentity::Native { model: "gpt-6.2-sol".into() });
    }

    #[test]
    fn decodes_picker_components_and_keeps_slashes_in_the_model() {
        let identity = ModelIdentity::parse("gateway:custom-abc:deepseek%2FV4.1%3Aflash");
        assert_eq!(identity.route_target(), Some(("custom-abc", "deepseek/V4.1:flash")));
    }

    #[test]
    fn malformed_gateway_values_are_invalid_not_native() {
        assert_eq!(ModelIdentity::parse("gateway:deepseek"), ModelIdentity::Invalid("gateway:deepseek".into()));
        assert_eq!(ModelIdentity::parse("gateway::model"), ModelIdentity::Invalid("gateway::model".into()));
    }
}
