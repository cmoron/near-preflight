// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// DemoToken's SimDetector trap in a contract of its own: its sale works only in a simulation that leaves
/// the gas price or the base fee at 0. Apart, so that the other demo tokens' code reads neither (the
/// sentinel warns on code that reads them). Local anvil copy of Base only.
contract SimToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    address public immutable owner;
    address public pair;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    /// Same arguments as DemoToken's (evm/fork.sh deploys both alike); the last two are unused.
    constructor(string memory name_, string memory symbol_, uint8, address) {
        name = name_;
        symbol = symbol_;
        owner = msg.sender;
        totalSupply = 1_000_000 ether;
        balanceOf[msg.sender] = totalSupply;
        emit Transfer(address(0), msg.sender, totalSupply);
    }

    function setPair(address pair_) external {
        require(msg.sender == owner, "owner");
        pair = pair_;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _move(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= value, "allowance");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - value;
        _move(from, to, value);
        return true;
    }

    function _move(address from, address to, uint256 value) internal {
        require(balanceOf[from] >= value, "balance");
        if (to == pair && from != owner && tx.gasprice != 0 && block.basefee != 0) revert("real sale refused");
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}
