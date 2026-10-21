use std::env;

#[tokio::main]
async fn main() {
    if let Err(error) = amll_lyrics_service::run_cli(env::args_os().skip(1)).await {
        eprintln!("amll-lyrics-service: {error}");
        std::process::exit(1);
    }
}
