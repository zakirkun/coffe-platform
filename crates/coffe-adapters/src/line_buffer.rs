/// Splits a byte stream into complete `\n`-terminated lines (LF only; a trailing `\r` is
/// stripped). Partial lines are kept until the next chunk. Lines longer than `max_line` bytes are
/// emitted in pieces so a misbehaving CLI cannot grow memory without bound.
#[derive(Debug)]
pub struct LineBuffer {
    pending: Vec<u8>,
    max_line: usize,
}

impl Default for LineBuffer {
    fn default() -> Self {
        Self { pending: Vec::new(), max_line: 8 * 1024 * 1024 }
    }
}

impl LineBuffer {
    pub fn with_max_line(max_line: usize) -> Self {
        Self { pending: Vec::new(), max_line }
    }

    /// Appends `chunk` and returns every line completed by it (without the terminator).
    pub fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        self.pending.extend_from_slice(chunk);
        let mut lines = Vec::new();
        let mut start = 0;
        while let Some(offset) = self.pending[start..].iter().position(|b| *b == b'\n') {
            let end = start + offset;
            let mut line = &self.pending[start..end];
            if line.last() == Some(&b'\r') {
                line = &line[..line.len() - 1];
            }
            lines.push(String::from_utf8_lossy(line).into_owned());
            start = end + 1;
        }
        self.pending.drain(..start);
        while self.pending.len() > self.max_line {
            let rest = self.pending.split_off(self.max_line);
            lines.push(String::from_utf8_lossy(&self.pending).into_owned());
            self.pending = rest;
        }
        lines
    }

    /// Returns the unterminated remainder (called when the stream ends).
    pub fn finish(&mut self) -> Option<String> {
        if self.pending.is_empty() {
            return None;
        }
        let rest = std::mem::take(&mut self.pending);
        Some(String::from_utf8_lossy(&rest).into_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::LineBuffer;

    #[test]
    fn joins_partial_chunks_and_strips_crlf() {
        let mut buf = LineBuffer::default();
        assert!(buf.push(b"{\"a\":").is_empty());
        assert_eq!(buf.push(b"1}\r\n{\"b\":2}\npartial"), vec!["{\"a\":1}", "{\"b\":2}"]);
        assert_eq!(buf.finish().as_deref(), Some("partial"));
        assert_eq!(buf.finish(), None);
    }

    #[test]
    fn does_not_split_on_unicode_line_separators() {
        let mut buf = LineBuffer::default();
        let text = "{\"t\":\"a\u{2028}b\"}\n";
        assert_eq!(buf.push(text.as_bytes()), vec!["{\"t\":\"a\u{2028}b\"}"]);
    }

    #[test]
    fn caps_unterminated_lines() {
        let mut buf = LineBuffer::with_max_line(4);
        assert_eq!(buf.push(b"abcdefghij"), vec!["abcd", "efgh"]);
        assert_eq!(buf.finish().as_deref(), Some("ij"));
    }
}
