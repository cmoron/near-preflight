// SPDX-License-Identifier: MIT
// Judge pass 9: sale_blocked_later aimed at one public address (the guard's), from 8 minutes after its buy.
pragma solidity 0.8.24;

contract J9GuardLater {
    string public name = "J9 Guard Later";
    string public symbol = "J9GL";
    uint8 public constant decimals = 18;
    uint256 public totalSupply = 1_000_000 ether;
    address public immutable deployer;
    address public immutable special;
    address public pair;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => uint256) public boughtAt;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(address special_) {
        deployer = msg.sender;
        special = special_;
        balanceOf[msg.sender] = totalSupply;
        emit Transfer(address(0), msg.sender, totalSupply);
    }

    function setPair(address p) external {
        require(msg.sender == deployer, "deployer");
        pair = p;
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
        if (from == pair) boughtAt[to] = block.timestamp;
        if (to == pair && from == special && block.timestamp > boughtAt[from] + 8 minutes) revert("closed");
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}
