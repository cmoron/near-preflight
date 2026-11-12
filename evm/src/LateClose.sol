// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IPairClock {
    function sync() external;
    function getReserves() external view returns (uint112, uint112, uint32);
}

/// Deployed only on a local copy of Base (anvil). Sales close for everyone at a moment its owner sets
/// (`arm`), here 20 minutes on: past a check's last sale, 900 s after the buy, so every sale a check
/// draws goes through. Two clocks: the TIMESTAMP opcode, or the token's own pool, whose `sync()` stamps it
/// with the block's time and whose `getReserves()` returns that stamp: no TIMESTAMP in the token's code.
/// A check that only samples sales allows both; one that reads what the token's code did does not.
contract LateClose {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply = 1_000_000 ether;
    address public immutable owner;
    /// True: the time comes from the pool (sync, getReserves). False: from TIMESTAMP.
    bool public immutable poolClock;
    address public pair;
    /// Sales to the pair revert from this time on (0: never).
    uint256 public closesAt;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory name_, string memory symbol_, bool poolClock_) {
        name = name_;
        symbol = symbol_;
        poolClock = poolClock_;
        owner = msg.sender;
        balanceOf[msg.sender] = totalSupply;
        emit Transfer(address(0), msg.sender, totalSupply);
    }

    function setPair(address p) external {
        require(msg.sender == owner, "owner");
        pair = p;
    }

    /// Owner only: sales close `delay` seconds from now.
    function arm(uint256 delay) external {
        require(msg.sender == owner, "owner");
        closesAt = _now() + delay;
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

    /// The pool is not locked when a sale's transferFrom reaches the token (the router calls swap after
    /// it), so sync() goes through there.
    function _now() internal returns (uint256 t) {
        if (!poolClock) return block.timestamp;
        IPairClock(pair).sync();
        (,, t) = IPairClock(pair).getReserves();
    }

    function _move(address from, address to, uint256 value) internal {
        if (to == pair && from != owner && closesAt != 0 && _now() >= closesAt) revert("closed");
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}
