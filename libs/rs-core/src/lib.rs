pub mod net;

pub fn network_connect(network_id: &str) {
    println!("Connecting to network with ID={network_id}...");
}

#[cfg(test)]
mod tests {
    #[test]
    fn it_works() {
        let result = 2 + 2;
        assert_eq!(result, 4);
    }
}
